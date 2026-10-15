# QQ space pagination rate limit

## Behavior

- Default: at most 5 page-request starts in any rolling 10-second window.
- One process-wide FIFO quota is shared by space browsing, exports, internal comment pages and account sessions. Opening another tab or changing settings does not reset recent usage.
- First pages, refreshes and HTTP retry attempts count. Existing Qzone post/feed/related/memories, album/photo, comment and forward-list page endpoints are classified centrally in `common/qzone_pagination.ts`.
- Statistics, nickname queries, individual details, publication/upload and media files are not pagination and are not charged. Local database browsing is unaffected. New server pagination paths must be added explicitly to the classifier.
- Excess requests wait before fetch. Abort removes queued work without consuming an admission. Admission history is bounded to the latest 1000 starts and uses a monotonic clock.
- Queue waits do not consume HTTP work/retry deadlines or the desktop Qzone operation watchdog. Network work retains its original bounded timeouts.

## Settings

Settings > Global Settings > QQ space pagination frequency exposes window seconds (integer 1..3600) and maximum pages (integer 1..1000). Both are saved together under `settings.qzonePagination` using the existing user configuration store. Old/malformed settings use safe defaults; a partial internal update preserves the other value.

Saved values configure the live limiter immediately, including queued work, without erasing admission history. Application startup reloads the saved values.

## Validation, 2026-10-15

- 11 targeted tests: rolling-window boundaries, FIFO bursts, cancellation, live configuration changes, missing/invalid settings, endpoint classification, real fetch admission, retry accounting, timeout exclusion, persistence/reload.
- Current worktree service regression: 871/871 pass across 83 files, including pre-existing uncommitted space improvements. Desktop Qzone boundary: 13/13 pass.
- Service and desktop main/preload/renderer typechecks pass; changed standalone settings/configuration files pass Biome checks.
- Four synthetic actual-settings-component browser cases pass: desktop/mobile, light/dark, defaults, invalid input, atomic save payload, reload readback and failed-save preservation; no JS errors or horizontal overflow. No real QQ requests were used for acceptance.
- Existing pure comment-parser/page-budget tests mock quota waiting; separate transport integration tests verify that real pagination dispatch cannot skip the limiter.

## Development Reload

This change affects the main process, service HTTP transport and settings RPC, not only the renderer. With the repository's ordinary `electron-vite dev` script, restart the development WeQ process once. A launcher using `--watch` can rebuild/restart the main process automatically; a renderer hot update alone is insufficient. Do not restart QQ for this change.

After this code is loaded, edits to the two frequency settings take effect on Save without another restart. No App packaging, installation, service restart, release or push was performed as part of the implementation.
