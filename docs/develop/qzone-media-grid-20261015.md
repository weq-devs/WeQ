# Qzone Media Preview Fixes, 2026-10-15

## Current Layout Contract

- One media item: preserve its natural aspect ratio; only constrain maximum width (540px, bounded by the available content width) and height (420px). Do not enlarge a smaller source to fill the gallery.
- Two or more items: use one shared 540px-wide gallery, responsive down to the available content width. Every image/video tile is square and uses cover cropping.
- Two items: two columns, one row. Three: three columns, one row. Four: two columns, two rows. Five or more: three columns per row.
- Images and videos share the same gallery and count. The full image/video lightboxes remain separate; preview cropping does not crop the original asset.

## Parser and Rendering Changes

The friend-feed HTML reader previously collected body images without distinguishing loader UI or video thumbnails; the owner-space reader already returned structured video objects. Video metadata (`data-v_vidiourl`, `data-v_vidioswfurl`, `data-v_itemid`, `data-v_picinfo_url`, `.f-video-wrap[url3]`, native video/source elements) is now projected as video data. Nested video wrappers and their cover/control images do not create extra photos.

Known static loader/control assets, 1x1 beacons, and unbacked loader placeholders are excluded. Real lazy-image targets are retained. This is not a rule to hide every failed image: a genuine content URL that fails still occupies its square tile and shows an unavailable status. Legacy SWF/HTML player links are not passed off as playable video files.

The supplied screenshots show the discrepancy but do not expose the original response HTML. The exact reported post has not been fetched or revalidated against the user's account. The known placeholder/video parsing paths were reproduced with synthetic fixtures; source-specific unrecognized markup remains a possible follow-up.

## Verification

- 13 browser parser cases cover placeholder exclusion, retained lazy targets, native/attribute video parsing, nested wrapper deduplication, cover exclusion from photos, rejection of script/legacy player addresses, and retention of genuine image failures.
- 48 desktop/mobile (1280/390px), light/dark scenarios each compare the actual friend-feed and owner-space components: single portrait/landscape photo/video, mixed counts 2-7, four photos, four videos and a failed real image. Assert gallery widths, tile geometry, natural single-item ratios, max bounds, 4=2x2 and no overflow/page errors.
- The real video lightbox played a small synthetic H.264 clip and reported advancing playback at 180x320. Image lightboxes retained the original aspect ratio. Fixture media is generated/test content, not the user's screenshots or private media.
- Desktop main/preload/renderer typechecks, 12 desktop Qzone RPC tests and changed-file Biome checks pass. Production bundling passes with the existing unrelated dynamic-import warnings.
- QA source/results: existing Agents project `work/ntqq-view-export-20261015/qzone-media-qa*`; generated screenshots are ignored under `apps/desktop/dist/`.
- No authenticated QQ requests, archive-disk reads, installs, packaged macOS App or push performed.

## Live Photo Question

No Live Photo classification is implemented by this change. Current structured readers map both `pic[].is_video/video_info` and top-level `video[]` to videos. Those shapes and a still-image/MP4 pair are not sufficient proof of Live Photo: normal videos also have covers, and mixed-media video entries can appear inside `pic`.

The inspected WeQ types, referenced QzonePhoto/QZoneExport readers and Tencent's public legacy Mood model do not provide a verified Live Photo discriminator for these response variants. This is lack of verified evidence, not a claim that current QQ endpoints can never supply one. Reliable classification needs an explicit type flag or a verified asset-pairing schema, compared against known Live Photo and normal-video response samples. Do not classify by filename, extension, duration, cover resemblance or array position.

### Authorized Two-Post Comparison, 2026-10-15

The user identified their newest post as one normal video and their second-newest post as 12 Live Photos, and authorized comparing them. A bounded read through the running development app's existing local MCP authentication path fetched one list page (`pos=0`, `num=2`) and the two corresponding R02 detail responses. All three Qzone requests returned `code=0`. Credentials and raw responses remained in memory; no media was downloaded, no older posts were requested, and no archive disk was accessed.

| Observed field | Known normal-video post | Known 12-Live-Photo post |
| --- | --- | --- |
| `video` | One entry | Empty array |
| `videototal` | 1 | 0 |
| `pic` | Absent | 12 entries |
| `pictotal` | Absent | 12 |
| `pic[].is_video` | Not applicable | 1 for all 12 |
| `pic[].video_info` | Not applicable | Present for all 12, with motion URL and video ID |
| `pic[].pic_id` and still-image URLs | Not applicable | Present for all 12 |

R02 detail responses confirmed the same media structure as the list. Both kinds use `rtype=3` and `t1_subtype=2`, so neither field separates them in these samples. The Live Photo motion durations include a reported zero as well as 1000/2000 ms; duration is not a classifier. Each Live Photo's nested `absolute_position` matches its index, but that is ordering metadata, not a type flag.

These known samples can be distinguished by their structural roles: standalone video versus photo entries with paired motion. This is evidence for a candidate rule, not proof that every mixed-media `pic[].is_video` entry is a Live Photo. Neither response exposes an independently verified Live Photo flag. Before introducing a general Live Photo label, compare a known ordinary-video-and-photo mixed post or obtain a verified discriminator. Keep the existing classification unchanged until that ambiguity is resolved; do not hardcode account/post IDs or the user's sample order.

This follow-up updates investigation notes only, not service/renderer behavior. No application restart, rebuild or HMR is needed for these notes. The earlier no-authenticated-request statement describes the preview-fix batch, not this subsequent authorized comparison.

## Development Reload

This batch changes renderer parsing, components and CSS only. Vite renderer HMR can load it without restarting the WeQ main process or QQ; the user's current live development process was not inspected. If it retains the old renderer state/styles, refresh the development window. Earlier main/service changes still require their own restart if not yet loaded.
