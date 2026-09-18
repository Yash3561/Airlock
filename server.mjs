import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Daytona } from '@daytona/sdk';

const root = fileURLToPath(new URL('.', import.meta.url));
const publicRoot = resolve(root, 'public');
const fixtureRoot = resolve(root, 'fixture');
const host = '127.0.0.1';
const port = Number(process.env.PORT || 4173);
const maxFiles = 120;
const maxFileBytes = 384 * 1024;
const maxTotalBytes = 3 * 1024 * 1024;
const maxBodyBytes = 5 * 1024 * 1024;
const sessions = new Map();
const events = [];
const now = () => new Date().toISOString();

function pushEvent(type, title, detail, state = 'info') {
  const event = { id: randomUUID(), at: now(), type, title, detail, state };
  events.unshift(event);
  if (events.length > 60) events.length = 60;
  return event;
}

function json(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  });
  res.end(JSON.stringify(payload));
}

function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

async function body(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) throw Object.assign(new Error('Request is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Request must contain valid JSON.'), { status: 400 }); }
}

const blockedPath = /(^|\/)(\.env(?:\..*)?|\.git|\.ssh|\.aws|\.azure|\.config|node_modules|secrets?)(\/|$)|\.(pem|key|p12|pfx|kdbx|sqlite|db)$/i;
const secretText = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bsk-[A-Za-z0-9_-]{24,}\b|\b(password|secret|api[_-]?key)\s*[:=]\s*['"][^'"\s]{8,}/i;

function normalizeProjectPath(value) {
  if (typeof value !== 'string' || value.length > 220 || value.includes('\\') || value.startsWith('/')) return null;
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.'))) return null;
  if (!/^[a-zA-Z0-9 _.-]+(?:\/[a-zA-Z0-9 _.-]+)*$/.test(value)) return null;
  if (blockedPath.test(value)) return null;
  return value;
}

function validateFiles(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > maxFiles) {
    throw Object.assign(new Error(`Choose 1–${maxFiles} text files.`), { status: 400 });
  }
  let total = 0;
  const seen = new Set();
  const files = input.map(file => {
    const path = normalizeProjectPath(file?.path);
    if (!path) throw Object.assign(new Error('A file path is unsafe or unsupported. Hidden folders, secrets, and path traversal are excluded.'), { status: 400 });
    if (seen.has(path)) throw Object.assign(new Error(`Duplicate file path: ${path}`), { status: 400 });
    seen.add(path);
    if (typeof file.content !== 'string') throw Object.assign(new Error(`${path} is not a text file.`), { status: 400 });
    const bytes = Buffer.byteLength(file.content, 'utf8');
    total += bytes;
    if (bytes > maxFileBytes || total > maxTotalBytes) throw Object.assign(new Error('Keep each file under 384 KB and the full project under 3 MB.'), { status: 413 });
    if (secretText.test(file.content)) throw Object.assign(new Error(`Possible credential found in ${path}. Remove it before opening a room.`), { status: 400 });
    return { path, content: file.content };
  });
  return files;
}

function requireSession(id) {
  const session = sessions.get(id);
  if (!session) throw Object.assign(new Error('That room is gone. Create a new one.'), { status: 404 });
  return session;
}

async function fixtureFiles() {
  const names = await readdir(fixtureRoot, { withFileTypes: true });
  const files = [];
  for (const entry of names) {
    if (!entry.isFile()) continue;
    files.push({ path: entry.name, content: await readFile(resolve(fixtureRoot, entry.name), 'utf8') });
  }
  return files;
}

async function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const file = resolve(publicRoot, relative);
  if (file !== publicRoot && !file.startsWith(publicRoot + sep)) return json(res, 403, { error: 'Forbidden.' });
  try {
    const content = await readFile(file);
    const type = ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' })[extname(file)] || 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    });
    res.end(content);
  } catch { json(res, 404, { error: 'Not found.' }); }
}

function getDaytona() {
  if (!process.env.DAYTONA_API_KEY) return null;
  return new Daytona({
    apiKey: process.env.DAYTONA_API_KEY,
    apiUrl: process.env.DAYTONA_API_URL,
    target: process.env.DAYTONA_TARGET,
    requestTimeoutMs: 30_000,
  });
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`);
  const pathname = url.pathname;
  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);
  if (!isSameOrigin(req)) return json(res, 403, { error: 'Cross-origin requests are not accepted.' });
  if (req.method === 'GET' && pathname === '/api/status') {
    return json(res, 200, {
      mode: process.env.DAYTONA_API_KEY ? 'live' : 'preview',
      provider: 'Daytona',
      configured: Boolean(process.env.DAYTONA_API_KEY),
      networkPolicy: 'block all outbound traffic',
      ttlMinutes: 30,
      events: events.slice(0, 12),
    });
  }
  if (req.method === 'GET' && pathname === '/api/fixture') {
    return json(res, 200, { files: await fixtureFiles() });
  }
  if (req.method === 'GET' && pathname === '/api/rooms') {
    return json(res, 200, { rooms: [...sessions.values()].map(s => ({ id: s.id, createdAt: s.createdAt, files: s.files.map(f => f.path) })) });
  }

  if (req.method === 'POST' && pathname === '/api/rooms') {
    const request = await body(req);
    if (request.consent !== true) return json(res, 400, { error: 'Confirm the upload and isolated execution before creating the room.' });
    const files = validateFiles(request.files);
    const daytona = getDaytona();
    if (!daytona) return json(res, 503, { error: 'Live isolation is unavailable: set DAYTONA_API_KEY in the server environment. Preview mode never executes project code.' });

    let sandbox;
    try {
      sandbox = await daytona.create({
        name: `airlock-${randomUUID().slice(0, 8)}`,
        language: 'javascript',
        ephemeral: true,
        ttlMinutes: 30,
        networkBlockAll: true,
        resources: { cpu: 1, memory: 2, disk: 5 },
      }, { timeout: 90 });
      await sandbox.fs.createFolder('/workspace', '755');
      for (const file of files) {
        const destination = `/workspace/${file.path}`;
        const parentParts = file.path.split('/').slice(0, -1);
        let directory = '/workspace';
        for (const part of parentParts) {
          directory += `/${part}`;
          await sandbox.fs.createFolder(directory, '755');
        }
        await sandbox.fs.uploadFile(Buffer.from(file.content, 'utf8'), destination);
      }
      const id = randomUUID();
      const session = { id, sandbox, daytona, files, original: new Map(files.map(file => [file.path, file.content])), createdAt: now(), events: [] };
      sessions.set(id, session);
      const notice = pushEvent('room', 'Isolated room created', `Ephemeral Daytona room · no host files or environment variables mounted · outbound network block requested · 30 minute lifetime.`, 'good');
      session.events.push(notice);
      const uploaded = pushEvent('upload', 'Project files uploaded', `${files.length} text files · ${(files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) / 1024).toFixed(1)} KB · nothing executed during intake.`, 'good');
      session.events.push(uploaded);
      return json(res, 201, { id, createdAt: session.createdAt, files: files.map(file => file.path), ttlMinutes: 30, events: session.events });
    } catch (error) {
      if (sandbox) await daytona.delete(sandbox).catch(() => {});
      pushEvent('error', 'Room creation failed', 'The provider could not create or populate the room. No local execution was attempted.', 'bad');
      return json(res, 502, { error: 'Could not create the remote room. Check the Daytona key and target, then retry.' });
    }
  }

  const match = pathname.match(/^\/api\/rooms\/([\w-]+)(?:\/(run|file|close))?$/);
  if (!match) return json(res, 404, { error: 'Not found.' });
  const [, id, action] = match;
  let session;
  try { session = requireSession(id); } catch (error) { return json(res, error.status || 500, { error: error.message }); }

  if (req.method === 'POST' && action === 'run') {
    const request = await body(req);
    if (typeof request.command !== 'string' || request.command.length > 240 || !request.command.trim()) {
      return json(res, 400, { error: 'Enter a short command to run inside the room.' });
    }
    const started = pushEvent('run', 'Command started', `Explicitly requested in isolated room: ${request.command}`, 'info');
    session.events.unshift(started);
    try {
      const result = await session.sandbox.process.executeCommand(request.command, '/workspace', undefined, 15);
      const stdout = String(result.result || '').slice(0, 12_000);
      const exitCode = Number(result.exitCode);
      const completed = pushEvent('result', exitCode === 0 ? 'Command finished' : `Command exited ${exitCode}`, stdout.slice(0, 500) || 'No output.', exitCode === 0 ? 'good' : 'warn');
      session.events.unshift(completed);
      session.events = session.events.slice(0, 16);
      return json(res, 200, { exitCode, output: stdout, events: session.events });
    } catch {
      const failed = pushEvent('result', 'Command stopped or timed out', 'The provider ended the command at the 15 second limit.', 'warn');
      session.events.unshift(failed);
      session.events = session.events.slice(0, 16);
      return json(res, 200, { exitCode: 124, output: 'Command stopped or timed out (15 second limit).', events: session.events });
    }
  }

  if (req.method === 'PUT' && action === 'file') {
    const request = await body(req);
    const path = normalizeProjectPath(request.path);
    if (!path || !session.original.has(path) || typeof request.content !== 'string') return json(res, 400, { error: 'Only an already-imported project file can be edited.' });
    if (Buffer.byteLength(request.content) > maxFileBytes || secretText.test(request.content)) return json(res, 400, { error: 'File is too large or appears to contain a credential.' });
    await session.sandbox.fs.uploadFile(Buffer.from(request.content, 'utf8'), `/workspace/${path}`);
    const event = pushEvent('edit', 'Candidate change synced', `${path} uploaded to the room; the original local file was not modified.`, 'good');
    session.events.unshift(event);
    return json(res, 200, { ok: true, events: session.events.slice(0, 16) });
  }

  if (req.method === 'GET' && action === 'file') {
    const path = normalizeProjectPath(url.searchParams.get('path'));
    if (!path || !session.original.has(path)) return json(res, 400, { error: 'That file is not in the imported project.' });
    const result = await session.sandbox.fs.downloadFile(`/workspace/${path}`);
    const content = Buffer.isBuffer(result) ? result.toString('utf8') : Buffer.from(result).toString('utf8');
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': `attachment; filename="${path.split('/').pop().replace(/[^a-zA-Z0-9_.-]/g, '_')}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    return res.end(content);
  }

  if (req.method === 'DELETE' && action === 'close') {
    try { await session.daytona.delete(session.sandbox, 30, true); }
    catch { return json(res, 502, { error: 'Remote deletion could not be confirmed. The provider’s 30 minute TTL will still expire the room.' }); }
    sessions.delete(id);
    pushEvent('close', 'Room destroyed', 'Remote room deleted on request; the provider TTL is also set to 30 minutes.', 'good');
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: 'Not found.' });
}

const server = createServer((req, res) => {
  handle(req, res).catch(error => {
    const status = error.status || 500;
    if (status === 500) console.error('AIRLOCK request failed:', error.message);
    json(res, status, { error: error.status ? error.message : 'Request failed. No code was executed on this computer.' });
  });
});

server.listen(port, host, () => {
  console.log(`AIRLOCK listening at http://${host}:${port}`);
  console.log(process.env.DAYTONA_API_KEY ? 'Mode: live remote sandbox' : 'Mode: preview only; no sandbox key configured');
});

process.on('SIGINT', () => {
  for (const session of sessions.values()) session.daytona.delete(session.sandbox).catch(() => {});
  server.close(() => process.exit(0));
});
