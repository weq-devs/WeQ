# Live Photo Read-API Investigation, 2026-10-15

## Scope

The user authorized exploring the other interfaces in the local API reference to distinguish the newest post's three labeled media items: ordinary video, Live Photo, static photo. This follows the R01/R02 mixed-media counterexample recorded in `qzone-media-grid-20261015.md`.

Reused the running development WeQ's local MCP credential service. Credentials and wire responses were held in memory only. Remote JSON/JSONP/object literals were parsed as data with the existing non-executing parser; remote HTML/scripts were not executed. Public source recipes were checked against the reference's pinned QzonePhoto, onebot-qzone and QZoneExport versions. No private identifiers, body text, signed URLs or credentials are retained here.

There were 15 content requests across 10 reference recipes, including the R01 anchor read and five R22 attempts. Total decoded response payload was 1,296,590 bytes. No retries of failed endpoints, continuation requests, media downloads, write endpoints, archive reads, app restarts, installations or pushes were performed. Small requested counts were not always honored: R13 returned metadata for 10 posts despite `showcount=1`; R14 returned 48 `friend_data` items despite `count=1`. Only the exact target post was analyzed for media classification. Do not describe these calls as retrieving only one post at the transport layer.

## Results

| Recipe | Actual result | Classification evidence / boundary |
| --- | --- | --- |
| R01, list anchor | HTTP 200, `code=0`, `num=1` | Confirmed the same three-item post; both moving items share `pic[].is_video=1` and `video_info`. |
| R04, attached pictures | HTTP 200, `result.code=0` | Returned one static photo in `imageUrls/images`, no moving-media type metadata. This envelope uses nested `result.code`, not top-level `code`; the supplement parser inspected at investigation start accepted only top-level `code`, identifying a compatibility gap. Other concurrent source edits were present at closeout and were not reviewed or committed here; this investigation does not certify their fix or tests. |
| R03, old detail GET | HTTP 500, empty body | No usable response; no POST fallback or retry. This does not establish permanent endpoint failure. |
| B02, mobile detail | HTTP 404, empty body | No usable response with the documented path and mobile headers; no alternate paths guessed. |
| R13, home module | HTTP 200; extracted `_feedsdata.code` is an empty string, not numeric zero | Exact owner/post match in metadata and HTML demonstrates the target payload was present; do not describe the empty code as `code=0`. No verified Live Photo marker in the target media markup or metadata. |
| R14, home activity | HTTP 200, `code=0` | Exact owner/post match in `friend_data`. All three target previews use the same popup markup. Provided popup topic and picture keys, but not a verified Live Photo type. |
| R22, popup-context keys | Three HTTP 200 responses, `code=-4003` | Each reports invalid album ID. A popup `data-topicid` is not necessarily an album ID; do not pass it to the album reader as though the contexts were interchangeable. No repeated attempts with guessed IDs. |
| R27, independent videos | HTTP 200, `code=0`, `count=3` | Both target moving items matched by exact video ID. Both `isNewFormat="true"`, `source=0`, `status=2`; being in this list does not distinguish ordinary video from Live Photo. |
| R20, albums | HTTP 200, `code=0`, first 10 albums | No established target-album relationship in that page. Did not traverse the rest or select by similar album name. |
| R15, own photo feed | HTTP 200, `code=0`, one response | Exact target matched by its post handle (`skey` here is a feed key, not the authentication skey). Three items: `photoType="1"`, `"1"`, `"0"`. Dynamic entries have empty `is_video`, `videourl`, `videokey`, `lloc`, `sloc`; empty `is_video` is not proof of a still image. Supplied an actual album reference. |
| R21, referenced album | HTTP 200, `code=0`, first 3 media | Obtained real album media keys. Third item matched the known static photo's location key exactly. First two had `is_video=true`, `phototype=1`; these were subsequently bound to the known dynamic items by R22 video IDs, not by array position alone. |
| R22, actual album keys | Two HTTP 200 responses, `code=0`, one photo each | Returned photos matched the requested `lloc/picKey`; nested `vid` exactly matched the known ordinary video and Live Photo respectively. Both had `phototype=1`, `is_video=true`, `video_info.video_type=0`, `format="f20"`, `status=2`, and reported `duration=0`. Both had the same field sets. |

R22 exposed useful download/playback metadata (`download_url`, `video_url`, `size`, `cover_width/height`, `vid`), but those are not verified Live Photo discriminators. The two R21 EXIF objects had no populated values. Asset dimensions, size, IDs, names, timestamps, duration or URL differences must not be promoted to semantic type rules.

## Conclusion

These tested web variants can distinguish static media from media carrying video, but do not expose a verified discriminator between the user's known ordinary video and Live Photo. In particular, `pic[]`, `videototal=0`, video-list membership, `photoType="1"`, `phototype=1`, and `video_type=0` all occur for both in this sample. This is a bounded observation, not a claim that no QQ endpoint or client protocol can preserve the original type.

R05, interaction/visitor/statistics endpoints, friend-wide R16, and unrelated logs/diaries/favorites were not invoked because they do not provide an established target-media typing path. Old names in the reference's registration-only section were not probed with invented parameters. No mobile QQ protocol, native database metadata or original-file inspection was performed or implicitly authorized.

No automatic Live Photo classification was added. A next investigation would require a documented current mobile/native type field or actual official-client network evidence for these known items. Do not implement classification by hardcoded sample identity/order or by duration thresholds.

## Reload And Verification

This batch changes investigation documentation only. No WeQ/QQ restart, renderer refresh or build is required. Validation consists of the real read-response codes and exact identity/key bindings above plus `git diff --check`; there is no new application behavior or GUI acceptance to claim.
