# GENAI Login

## Version 0.0.8

GENAI Login is a local VS Code extension for UMPASS authentication and an OpenAI-compatible bridge.

## Usage

Open GENAI in the activity bar. The connection dashboard provides square action tiles for account setup, connection, disconnect, and clearing saved data. It also shows the local port, connection uptime, bridge request count, model usage, keepalive state, and token usage reported by GENAI.

Edge must be installed. A saved valid cookie jar skips the browser login. Otherwise the extension starts temporary headless Microsoft Edge, fills the saved UMPASS credentials once, and waits for the normal MFA and redirect flow. After API verification, the Edge session remains available until Disconnect so the session can be kept alive. Disconnect, timeout, cancellation, authentication failure, window reload, and VS Code exit close it.

Credentials and cookies are stored in VS Code SecretStorage. Clear removes both stored values; it does not revoke the server-side session.

Endpoint: `http://127.0.0.1:58379/v1/chat/completions`. Compatibility key: `local-browser-session`. The bridge requires the fixed local Host, Bearer, and Fetch Metadata checks and refuses requests with an Origin header. The compatibility key is not a strong security boundary against other local programs, so do not expose the port beyond loopback.

Only one VS Code window can own port 58379. Stop an older bridge before connecting. The bridge retries one request after authentication expiry; streamed conversations are not automatically replayed. The 60-second keepalive is serialized so checks cannot overlap, and refreshed cookies are persisted.

Token totals use `prompt_tokens` and `completion_tokens` from upstream JSON or SSE usage data. Requests without usage data are counted but do not receive an invented token estimate. Model tracking is bounded to keep malformed or unusual model names from growing memory without limit.

## Verification

Run `npm test` for lint, statistics regression tests, and VS Code integration tests. Successful account login and any account-specific MFA must be verified by the user through the extension's password input.