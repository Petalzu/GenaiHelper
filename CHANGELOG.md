# Change Log

## [0.0.12]

- Added per-model token, cache and reference cost details to the dashboard.
- Added frozen reference pricing for supported models, CNY conversion and DeepSeek peak/off-peak estimates.
- Applied a 90% cached-input fallback when cache usage is missing or invalid.
- Stored historical usage in a single summary without repricing previously saved estimates.
- Added regression coverage for pricing, cache fallback, time boundaries and history persistence.

## [0.0.11]

- Added persistent historical request and token usage totals with a compact dashboard display.
- Preserved usage history across disconnects and credential clearing, with independent records per window.
- Updated streaming response handling and added formatting diagnostics.
- Added regression coverage for historical usage, stream forwarding, and local bridge access.

## [0.0.10]

- Added multi-select Copilot model management with fixed presets, deduplication, precise deletion and backups.
- Added configurable port and idle timeout (disabled by default), plus a port settings tile.
- Hardened streaming cancellation and long-response forwarding without automatic partial replay.
- Added visible-only cross-window synchronization and retained dashboard context.
- Updated activity icon and opaque, layout-stable detail overlays.
- Deferred heavy connection dependencies and added dashboard startup timing diagnostics.
- Published a ready-to-install VSIX through GitHub Releases.

All notable changes to the "genai-login" extension will be documented in this file.

## [Unreleased]

- Initial release

## [0.0.8]

- Replaced the recursive sidebar tree with a Webview connection dashboard.
- Added bounded request/model statistics and upstream usage-based token totals.
- Serialized the 60-second cookie keepalive and persisted refreshed cookies.
- Added regression coverage for SSE parsing, usage accumulation, and model bounds.