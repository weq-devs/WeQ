# Qzone Reader Enhancements, 2026-10-15

Follow-up scope change: the user subsequently removed the R18 UI and moved it and the forward-list UI to [TODO](qzone-todo.md). Special care now lives in the friend-feed dropdown; related-to-me now uses collapsed activity cards rather than full post cards. The verification below describes the earlier implementation, not acceptance of these later UI changes.

## Body Continuation Follow-Up

The detail DTO now separates explicit `has_more_con/rt_has_more_con` values from absent flags (`true`, `false`, or `null`). The UI only continues when a flag explicitly reports more text; absent flags or an explicit end stop quietly, without the old completeness-uncertainty hint. This does not upgrade absent flags to evidence of archival completeness; the existing `contentComplete/repostComplete` fields retain their strict meaning.

R02 returns a whole body and has no verified paging cursor. Each visible completion round therefore re-reads R02 only while more is explicit, updates the body in place, and stops on a repeated/cycling response or five reads. These two stops report actual remaining truncation, not missing metadata. Later failures and failed manual retries retain the longest acquired excerpt; cancelled/late results do not change a hidden post. Responses are not concatenated as if they were text chunks.

Follow-up verification: 849 service tests, 41 focused parser/continuation/RPC tests (overlapping the suite), desktop main/preload/renderer typechecks and Biome checks pass. The actual QzoneView passes 28 synthetic desktop/mobile light/dark cases covering missing/end/more flags, stalled/capped responses, failures with retry, and late cancellation, without page errors or viewport overflow. QA: `qzone-body-qa*` in the existing local work directory below. No authenticated QQ requests or application restarts were performed. This follow-up changes bundled service code as well as renderer code, so the default development process must be restarted.

## Implemented Scope

- R02: automatically request details for a visible post with explicit body/repost truncation. Keep existing content on failures, allow explicit retry, and only declare completeness when the response clears its truncation flag. Longer content without a completeness flag remains unverified. Responses with mismatched author/post identifiers are rejected when those fields are present.
- R04: automatically supplement a visible post when its declared `pictotal` exceeds returned `pic` entries. Top-level videos do not satisfy the returned-pic count. Insert the response's ordered image URLs into the same post, remove exact URL duplicates and retain existing images if the result is partial. Rendering retains the existing resource allowlist/proxy. An image URL is not evidence that an original file was downloaded.
- R12: the friend-feed checkbox uses server `scope=7`, not local nickname matching. Changing scope remounts the timeline and clears its cursor/loaded rows; filters cannot leak content from the previous scope.
- R17/R18: separate "related to me" and "on this day" tabs. R17 only continues using a forward server-provided offset. R18 has a year selector and a bounded 30-item request; its has-more flags do not supply a proven paging recipe. The UI explicitly reports unconsumed content instead of inventing a next page or claiming complete history.
- R20: use ordered `mode=2`, `pageStart/pageNum=40` album pages. Retain unknown totals, continue short pages when an explicit total requires it, merge by album ID, stop automatic loading on duplicates or changing totals, and bound each catalogue traversal to 200 pages. Unknown totals and early empty pages are not complete-catalogue claims. This applies to the album browser; the legacy first-batch service API remains compatible for other consumers.
- R22: photo/video detail reads use the requested `picKey/lloc/sloc` exactly. Never select an arbitrary video in the response. Use available original-image/video URLs and show returned dimensions; absent playable video URLs remain cover images. Existing export/playback video resolution now also uses this exact-key check.
- All new RPCs use the existing online/current-account boundary, bounded request queue, cancellation and stale-result checks. Completion failures do not automatically loop. Switching away cancels pending reads and rejects late UI updates.

## Awaiting User Review

R13/R14 as the primary owner-space timeline is not implemented here. These recipes return mixed feeds rather than only posts. Proposed design: make the mixed "Activity" pane use R13 for the initial page and R14 for continuation; retain a distinct post-only view/filter, with R01 used for exact post supplementation. Do not reuse the post total as a mixed-feed total or treat one source's absence as deletion evidence. The initial HTML data extraction and continuation semantics require separate verification before replacing the existing source.

## Evidence and Limits

Request/response recipes were checked against pinned original source implementations:

- [QZoneExport clients](https://github.com/ShunCai/QZoneExport/blob/7e0218fab29316ca28b99a7c63deb0627002d271/core/qzone-api/clients.ts).
- [QZoneExport post collector](https://github.com/ShunCai/QZoneExport/blob/7e0218fab29316ca28b99a7c63deb0627002d271/core/collector/modules/messages.ts).
- [QzonePhoto feed/album readers](https://github.com/11273/QzonePhoto/blob/d74b7ffb3026074c44dbb193915f8fc63af5c891/src/main/api/qzone/photo.js).

No authenticated QQ requests, archive-disk reads, login changes, installs, or real-account acceptance were performed. Some reference clients supply `qzonetoken`; the new readers reuse WeQ's existing domain credential flow and do not create a login/token acquisition bypass. Compatibility of these response variants and whether this account requires an additional page token remain unverified. Rejected responses preserve the original visible content. Only explicitly identifiable feed posts are eligible for direct R02 completion; timestamps/aliases are not invented as canonical tids.

GUI QA uses the actual QzoneView/album/lightbox components with synthetic API data and an existing fixture PNG. It is not an authenticated-content or real-media acceptance test.

## Verification

- Service suite: 847 tests passing, including 17 new completion/feed/page/detail tests.
- Desktop RPC boundary: 12 tests passing, including scope, identity and argument validation.
- Service and desktop main/preload/renderer typechecks pass.
- Changed TypeScript files pass Biome lint/format; whitespace check passes.
- `electron-vite build` passes; existing unrelated dynamic-import warnings remain.
- 16 desktop/mobile (1280/390px), light/dark, normal/failure/stalled-page/delayed-response cases pass: automatic R02/R04, original content retention, explicit retry, no automatic failed retry, scope isolation, exact R17 offsets, R18 year/partial state, more than 40 albums, duplicate-page stop, R22 original URL and dimensions, cancelled hidden-post completion, and no JS errors or viewport overflow.
- QA sources/results are kept outside the repository in a private local workspace. Generated screenshots live in ignored `apps/desktop/dist/`.

## Development Reload

Renderer-only changes support Vite HMR. This batch also changes the main-process router and bundled service code. The repository's ordinary `pnpm dev` configuration does not set `main.build.watch`; restart the development WeQ process to load the entire batch. If explicitly using a watch-enabled startup, main rebuilds restart Electron rather than hot-replacing the live main process. No QQ restart is needed. No new packaged macOS App was produced.
