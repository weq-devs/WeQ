# QQ space pagination rate limit

## Behavior

- Default: at most 5 page-request starts in any rolling 10-second window.
- One process-wide FIFO quota is shared by space browsing, exports, internal comment pages and account sessions. Opening another tab or changing settings does not reset recent usage.
- First pages, refreshes and HTTP retry attempts count. Existing Qzone post/feed/related/memories, album/photo, comment and forward-list page endpoints are classified centrally in `common/qzone_pagination.ts`.
- Statistics, nickname queries, individual details, publication/upload and media files are not pagination and are not charged. Local database browsing is unaffected. New server pagination paths must be added explicitly to the classifier.
- Excess requests wait before fetch. Abort removes queued work without consuming an admission. Admission history is bounded to the latest 1000 starts and uses a monotonic clock.
- Queue waits do not consume HTTP work/retry deadlines or the desktop Qzone operation watchdog. Network work retains its original bounded timeouts.

## Settings

Settings > QQ Space Settings > Online pagination rate limit exposes window seconds (integer 1..3600) and maximum pages (integer 1..1000). This is a dedicated settings navigation section, not part of Global Settings. Both are saved together under `settings.qzonePagination` using the existing user configuration store. Old/malformed settings use safe defaults; a partial internal update preserves the other value.

Saved values configure the live limiter immediately, including queued work, without erasing admission history. Application startup reloads the saved values.

## Validation, 2026-10-15

- 11 targeted tests: rolling-window boundaries, FIFO bursts, cancellation, live configuration changes, missing/invalid settings, endpoint classification, real fetch admission, retry accounting, timeout exclusion, persistence/reload.
- Current worktree service regression: 871/871 pass across 83 files, including pre-existing uncommitted space improvements. Desktop Qzone boundary: 13/13 pass.
- Service and desktop main/preload/renderer typechecks pass; changed standalone settings/configuration files pass Biome checks.
- Four synthetic actual-settings-component browser cases pass: desktop/mobile, light/dark, defaults, invalid input, atomic save payload, reload readback and failed-save preservation; no JS errors or horizontal overflow. No real QQ requests were used for acceptance.
- Existing pure comment-parser/page-budget tests mock quota waiting; separate transport integration tests verify that real pagination dispatch cannot skip the limiter.

## Development Reload

This change affects the main process, service HTTP transport and settings RPC, not only the renderer. With the repository's ordinary `electron-vite dev` script, restart the development WeQ process once. A launcher using `--watch` can rebuild/restart the main process automatically; a renderer hot update alone is insufficient. Do not restart QQ for this change.

### Stale Main Process Diagnosis, 2026-10-15

The local desktop launcher used `electron-vite dev --rendererOnly`. The running development command confirmed that flag, and its `out/main/index.js` was built at Beijing time 19:29, before the pagination limiter was added at 21:39. That compiled main contained neither the limiter nor `setQzonePagination`. Restarting that same renderer-only launcher would continue to reuse the old backend. This is concrete stale-runtime evidence, not a server-side rate-limit failure.

The existing local launcher now uses normal `electron-vite dev`, which builds main and preload before starting Electron; its runtime/native paths and normal-exit checks are unchanged. No running WeQ/QQ process was stopped, and the running process's main bundle was not rebuilt in place. The user must quit WeQ normally and reopen the same launcher to load current code. The settings UI explicitly reports an unavailable old backend rather than displaying an indefinite loading state, and uses cached saved values immediately when remounting.

Additional verification: 11 quota tests pass; real-clock synthetic HTTP admission across six different pagination endpoints occurred at approximately 0.04/0.24/0.25/0.25/0.25/10.01 seconds. Saving a 1-second/1-page limit then admitted the next pages near 11.01/12.01 seconds without resetting history. No real QQ requests were used. Four actual SettingsDialog desktop/mobile light/dark cases verified the independent navigation section, absence from Global Settings, save/readback across navigation, stale-main error state, and unclipped controls/labels. The existing launcher's zsh syntax check passed; real application relaunch remains for the user.

After this code is loaded, edits to the two frequency settings take effect on Save without another restart. No App packaging, installation, service restart, release or push was performed as part of the implementation.
