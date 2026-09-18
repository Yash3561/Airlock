# AIRLOCK workroom

AIRLOCK is a candidate-side workroom for completing code take-homes in an ephemeral remote environment. Its product claim is deliberately narrow: the candidate can import files without running them, explicitly choose when to execute a command, and export a changed file from a short-lived room. It is not a malware scanner and does not claim to prove a task is safe.

## Run the preview

1. Install Node.js 20 or newer.
2. From this directory, run `npm install` once and `npm start`.
3. Open `http://127.0.0.1:4173`.
4. Load the included fictional inventory take-home. Preview mode does not upload or execute anything.

## Enable a live room

Set a Daytona API key in the server's environment, then restart `npm start`:

- Windows Command Prompt: `set DAYTONA_API_KEY=your-key` then `npm start`
- PowerShell: `$env:DAYTONA_API_KEY="your-key"` then `npm start`

The key is read only by the Node server; it is never sent to the browser. Do not paste the key into the UI or check it into source control. AIRLOCK creates an ephemeral JavaScript sandbox with `networkBlockAll: true`, a 30 minute TTL, no mounted volumes, and no project environment variables. The user must check consent before files are sent. Commands run only after an explicit button press and are capped at 15 seconds. The server binds to `127.0.0.1`.

## Demo path

1. Load the included sample task and explain that intake never runs code.
2. For the live demo, set the key before the event and open a room with the sample.
3. Run `node tests.mjs`; it fails because the last page is skipped.
4. Edit `inventory.mjs` so the loop includes every page, click **Sync changes to room**, and run the test again.
5. Run the harmless network probe only if the room is live. A failed request is not, by itself, proof that network policy caused the failure; do not claim firewall telemetry unless you can show it.
6. Export the changed file, then destroy the room.

## Limits to say out loud

- The working remote-room path requires a Daytona account/API key. Without one, the page says **Preview** and does not execute project code.
- This prototype accepts text files, not archives or Git URLs. It omits common credential locations and patterns, but that is only a conservative intake filter, not a complete secret scanner.
- A network-block setting is sent to the provider. The UI's receipt records the requested configuration; independent proof of enforcement needs provider telemetry or a controlled network test.
- There is no embedded Codex/Fable agent yet. Do not send agent API credentials into the room. The first slice is manual editing plus isolated command execution.
- Untrusted code still runs inside a third-party disposable runtime. Keep resource/time caps and never describe a sandbox as unbreakable.

## Team plan for the remaining event time

| Owner | Deliverable | Stop condition |
| --- | --- | --- |
| Yash | Run the demo, keep the story honest, get one practitioner quote, own submission | If three practitioners say they never receive code tasks, pivot story before adding features |
| Kaushik | Bring up Daytona credentials and prove room create/delete and the 15-second command limit | If no live room by 1:30 PM, present preview as a product workflow and never claim live containment |
| Jaishnav | Try fresh folder import, check excluded-file behavior, and prepare a second harmless task | Stop adding import types if basic intake is flaky |
| Jyothna | Tune UI and rehearse judge interaction; capture requested-versus-observed evidence | No fabricated event logs or policy proof |

Tomorrow's differentiator is a user experience, not a declaration that the code can detect every attack: **the candidate can do the work while deciding what crosses the boundary and what leaves it.**
