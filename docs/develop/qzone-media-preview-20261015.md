# Qzone Media Preview, 2026-10-15

## Current Performance Fix And Removals

The user's subsequent request supersedes the album-entry portions below: remove the preview's album entry and the space visitor-count display while fixing performance. The original implementation/verification below describes commit `c5ea07de`, not the current product contract.

- Removed the entire preview footer and its album-name resolution props/effects, gallery-side lookup state and RPC hooks, plus the now-unused `postAlbum` route/service/module. Previews make no R15/R25 requests. Existing album navigation elsewhere remains available.
- Removed the space visitor-count label and stopped fetching visitor counts in `getQzoneSpaceStats`. Only post/photo content totals are read; per-post view counts are unchanged. Content-count failure/cancellation handling remains tested.
- Replaced the viewport's per-mousemove `getBoundingClientRect` and inline cursor writes with CSS-only left/right blank-space buttons behind the media. Existing accessible navigation buttons remain. Media and native video controls stay above the blank-space targets.
- Existing album photos render immediately instead of waiting for R22. Detail completion can upgrade the image; a failed detail read preserves the usable photo and offers a toolbar retry. A failed upgraded image also falls back to the existing photo rather than leaving a blank preview.
- Per-open preview detail promises/results are reused by media key and loader identity, including in-flight requests. Failed loads are evicted for retry; caches disappear when the preview closes. This is metadata/URL caching, not a duplicate media download cache.

Measured synthetic before/after, using the same fixture:

| Check | Before | After |
| --- | --- | --- |
| Viewport layout reads for 1,000 mousemove events | 1,000 | 0 |
| Photo visible 120 ms into a simulated 600 ms detail request | No | Yes |
| Detail requests for A -> B -> A in one album preview | A, B, A | A, B |

The running WeQ/Electron process was absent at inspection, so these are reproduced code-path improvements, not a profile of the user's original live stall or a claim about overall frame-rate/CPU gains. No unrelated processes were stopped.

Current verification: desktop typechecks, 9 statistics tests, 12 Qzone RPC tests, 10 preview browser scenarios (including missing original/retry, no footer, stale responses and actual album component), 48 feed/space media-grid scenarios and 13 parser cases pass. The media-grid suite also asserts zero album-lookup calls and no visitor-count label. Performance QA sources/before/after receipts are the existing Agents project's `qzone-preview-perf-qa.mjs`, `qzone-preview-perf-baseline.json` and `qzone-preview-perf-results.json`. Original album-query tests were removed with that feature; the earlier service-suite count is not presented as a new full-suite run.

Production `electron-vite build` passes with the existing dynamic-import/deprecation warnings; the main bundle no longer contains the album resolver. UI/performance changes support renderer HMR. Removing the main-process album RPC and visitor read requires one development WeQ restart to fully load the new backend; no QQ restart is required. No App packaging/installation, authenticated content reads or push is part of this batch.

## Behavior

- Qzone post/repost galleries, feed galleries and album media use one Qzone-specific photo/video preview. Chat image/video lightboxes are not replaced.
- The album name occupies a separate footer below a clipped media viewport. The toolbar is also outside that viewport. Zoomed images cannot cover either area. Long names truncate with the full name available on hover.
- A confirmed album name opens the existing account-scoped album navigation; when already viewing that album, it closes the preview and returns to the album. No new external browser page is opened.
- Photos support zoom-in/out buttons, fit reset, cursor-anchored wheel zoom, click zoom and drag-to-pan, reusing `useZoomPan`. The displayed scale is relative to the initial fitted view, from 1x to 8x. Media changes reset the transform; closing/changing media removes drag listeners.
- Left/right space outside the media navigates within the current post gallery or loaded album media, including photo/video transitions. Directional cursors and accessible arrow buttons indicate the available action. Ends do not wrap or automatically fetch another album page. Arrow keys also navigate, except when the native video control has focus. Escape/close restore focus to the entry control.
- Album media resolves its exact `picKey` on demand. Late resolutions cannot replace the newly selected item. Playback/download failures are not presented as successful media loads.

## Album Identity

Known album views reuse their actual album ID/name. Album-feed links are used only for a single owner-matched album target in an album feed, not arbitrary links shared in post text.

For posts without album metadata, opening the preview can read one R15 response and select only an exact owner/post-key match. An unnamed, unambiguous album reference is queried via R25. R15 uses the logged-in viewer as `uin`; R25 follows its source recipe's target-owner `uin`. Cookies always retain the logged-in identity. The renderer receives only `{ hostUin, topicId, name }`, not raw album permission/question/answer data.

This lookup is intentionally bounded to that response, not a scan of all albums or post history. Older posts not present there, comments without a proven album relationship, ambiguous results and unavailable metadata display an unavailable state rather than a guessed link. Failed lookups can be retried; successful names are cached only in the mounted, account/post-scoped gallery and reset on refresh. Hidden/unmounted previews cancel their reads. The new RPC uses the existing online-account checks, timeout and cancellation boundary.

## Verification

- Desktop main/preload/renderer typechecks pass. Changed TypeScript Biome checks and `git diff --check` pass.
- Service suite: 853 tests pass; the new album resolver tests cover exact owner/post binding, unrelated/null entries, ambiguous albums, malformed/error envelopes, album-name identity, precise request parameters and cancellation. A focused rerun after the R25 identity-parameter correction also passes.
- Desktop Qzone RPC suite: 13 tests pass, including the new online-account-bound album lookup.
- 11 synthetic browser scenarios cover desktop/mobile (1280/390), light/dark environments, reserved footer/toolbar geometry, zoom buttons/wheel/click/pan/reset, scale reset between items, real generated H.264 playback, both navigation directions/cursors, exact album navigation, focus restoration, missing/failed album lookup, stale media resolution and the actual album-list component's sequential `p1/p2/p3` detail requests.
- Existing media-grid regression: 48 desktop/mobile light/dark scenarios in actual feed/space components plus 13 parser cases pass, including single natural ratios, fixed-width square grids, 4=2x2, retained genuine image failures, video playback and uncropped photo previews.
- Production `electron-vite build` passes with the existing dynamic-import/deprecation warnings. This is a bundle build, not a newly packaged macOS App or installation.

QA scripts/results are in the existing Agents project's `work/ntqq-view-export-20261015/qzone-preview-qa*` and `qzone-media-qa*`. Assets are generated test content, not private media. The real-account check could not proceed because the running WeQ MCP endpoint was not reachable; do not claim live validation of the new R15/R25 name resolver. Earlier investigation verified R15 album references but not this new name-resolution workflow. No authenticated content reads, media downloads, archive access, app restart, installation or push were performed in this implementation batch.

## Development Reload

Renderer/component/CSS changes support Vite HMR. The new `postAlbum` RPC and service implementation require restarting the development WeQ once under the default/renderer-only launcher. The current production main bundle has been rebuilt. No QQ restart is required; the user retains control of the running application.
