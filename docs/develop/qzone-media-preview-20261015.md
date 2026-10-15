# Qzone Media Preview, 2026-10-15

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
