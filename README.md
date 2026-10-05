# GENAI Login

Manual UMPASS login and local API bridge for desktop VS Code. Open GENAI in the activity bar to use the connection dashboard, save credentials, and connect. The extension uses a temporary headless Microsoft Edge session for the normal MFA flow, keeps that browser session alive until Disconnect, and stores credentials and cookies in VS Code SecretStorage.

The endpoint remains http://127.0.0.1:58379/v1/chat/completions with compatibility API key local-browser-session. Stop the old bridge first. MFA is not bypassed. The dashboard shows port, uptime, bridge requests, models, and upstream-reported token usage. Network failures require retrying the request; authentication expiry triggers one login attempt. Reloading the window stops the bridge, but saved credentials persist. See GENAI-README.md for details.

## Features

- **Manual login flow** — you enter UMPASS credentials, the extension drives the normal OIDC → password → MFA flow; nothing is bypassed or harvested.
- **Local OpenAI-compatible bridge** on `127.0.0.1:58379` with `/v1/models` and `/v1/chat/completions`, including SSE streaming passthrough.
- **Connection dashboard** (webview) showing status, port, uptime, request count, per-model usage, keepalive state, and upstream-reported token usage.
- **SecretStorage only** — credentials and cookie jars never touch plain configuration files or the filesystem.
- **Keepalive** — a serialized 60-second session check persists refreshed cookies and reauthenticates once when the session expires.

## Requirements

- Desktop VS Code (extension kind `ui`; it does not run in Remote/SSH windows).
- Microsoft Edge installed on the machine running VS Code.
- A valid UMPASS account with access to GENAI.

## Installing from source

```bash
git clone <this-repository>
cd genai-login
npm install
```

Open the folder in VS Code and press **F5** (Run Extension), or package a VSIX locally:

```bash
npx @vscode/vsce package
```

Install the generated VSIX via *Extensions: Install from VSIX…*.

## Usage

1. Open the **GENAI** view in the activity bar.
2. Save your UMPASS account and password (stored in SecretStorage).
3. Press **Connect**. A temporary headless Edge opens, completes the login/MFA flow, and closes after successful API verification.
4. Point OpenAI-compatible clients at `http://127.0.0.1:58379/v1` with the API key `local-browser-session`.

If a saved cookie jar is still valid, login is skipped entirely.

## Extension Settings

This extension contributes no settings. All state lives in SecretStorage and the fixed bridge port `58379`.

## Known Issues

- Only one VS Code window can own port 58379; stop the other bridge first.
- Network failures are not retried automatically — resend the request.
- Streamed conversations are not replayed after an automatic relogin.
- The compatibility key `local-browser-session` is not a strong boundary against other local programs; never expose the port beyond loopback.

## How it works

```
Chat client ──> 127.0.0.1:58379 (Host/Bearer/Fetch-Metadata checks)
                    │
                    ▼
        auth.js / browser-auth.js
        (cookie jar + headless Edge login)
                    │
                    ▼
        https://chat.genai.um.edu.mo/api/v1
```

`auth.js` performs form-based OIDC/SAML login with fetch and a `tough-cookie` jar. `browser-auth.js` falls back to a temporary headless Edge session via `playwright-core` when the form flow hits interactive steps (e.g. MFA). Upstream hosts are pinned to `chat.genai.um.edu.mo`, `login.um.edu.mo`, and `websso.um.edu.mo`; redirects to any other host are refused.

The local bridge enforces:

- Host header must be exactly `127.0.0.1:58379`
- `Origin` header must be absent (blocks browser-based callers)
- `Sec-Fetch-Site` must be `none` or absent
- `Authorization: Bearer local-browser-session`

## Security notes

- Credentials and cookie jars are stored in VS Code SecretStorage; **Clear** removes both stored values but does not revoke the server-side session.
- No telemetry, no analytics, no data leaves the machine except requests destined for the pinned GENAI hosts.

## License

MIT — see [LICENSE](LICENSE).
