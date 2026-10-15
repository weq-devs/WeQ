# QQ space statistics, 2026-10-15

## Change

- Replace the loaded-post/total pagination fraction with space visit occurrences, post count and photo count on each owner's post timeline.
- Display post reads alongside likes/comments. Reuse `qz_opcnt2`'s `newdata.PRD` in the existing lazy interaction request; do not count liker identities as reads.
- Read space visit occurrences using `friendshow/cgi_get_visitor_simple`, `mask=1`, `data.modvisitcount[0].totalcount`. Do not substitute today's count, recent visitor list size, or a sum across modules.
- Read content totals using `main_page_cgi`, `param=16`, `data.module_16.data.SS/XC`. Do not sum the first page's album media counts or use the loaded post count as the total.
- Preserve explicit zero. Missing, unsafe, malformed or denied counters stay unknown and can be retried. Content/visitor requests fail independently; cancellation and account-session checks remain mandatory.
- Keep statistics separate for each open space, refresh with the existing page refresh, and use existing theme tokens and wrapping layout.

## Sources and Acceptance Boundary

The response paths are based on original API-reader implementations, not invented counts:

- [Post PRD reader](https://github.com/Gu-Heping/onebot-qzone/blob/main/src/qzone/client.ts), `getTrafficData`.
- [Space visitor total reader](https://github.com/netcccyun/qqapi/blob/master/includes/lib/QQTool.php), `getvisitcount`.
- [Space content total reader](https://github.com/wwwpf/QzoneExporter/blob/master/exporter.py), `_get_main_page_data`, and its photo-count mapping.

These are implementation references, not proof that the current account's upstream responses still have the same schema or that the current server's `XC` matches its displayed photo-count semantics. No authenticated live QQ requests were made in this change. Real-account comparison against QQ's own view remains unverified; permissions may leave counters unknown.

## Verified

- Service tests: 830/830 pass, including 9 new statistics/read-count cases.
- Desktop Qzone boundary: 11/11 pass. Updated two existing stale fixtures for the current nickname DTO and HostBridge image validation; no production behavior changes for those fixture repairs.
- Service typecheck and desktop main/preload + renderer typechecks pass.
- Changed TypeScript files pass Biome lint/format; `git diff --check` passes.
- `electron-vite build` passes. Existing dynamic-import/chunk warnings remain; this is bundling, not a new `.app` package.
- Actual QzoneView with a synthetic transport: 16 desktop/mobile (1280/390px), light/dark, normal/unknown/error/loading cases pass. Verified explicit zeros, failure/partial-data retry, owner switching, view counts, no page errors and no viewport/statistics overflow. No real media or account acceptance is claimed.

QA sources/results: `/Users/wata4me/Agents/2026-09-18-weQ大数据库解密修复/work/ntqq-view-export-20261015/qzone-stats-qa*`.
Screenshots: `apps/desktop/dist/qzone-stats-*.png` (ignored generated artifacts).

No application install/replacement, authenticated QQ collection, archive-disk access, push or release performed for this change. The previous `2.0.2-local.27` App is unchanged and does not include this change.
