# Qzone Share Cards, 2026-10-15

## Change

The prior projection recognized a linked image only when the image was nested inside its anchor. Article/music blocks with sibling cover and title elements could lose their card structure; descriptions and source labels were not part of the projected link data. The UI also rendered remaining links primarily as text.

- Project known dedicated text/image share wrappers into native card fields: URL, full title (including an available title attribute), cover, description, source and music/link kind.
- Preserve authored `.f-info` text outside the extracted block. Do not consume identity links, photo-viewer links or video wrappers as share cards. Later plain anchors do not overwrite richer card metadata for the same destination.
- Read existing lazy-image attributes, safe background-image URLs and cover attributes. Normalize protocol-relative QQ image URLs to HTTPS while retaining the existing domain, scheme, credentials and port checks.
- Render compact, theme-aware cards with fixed square cover geometry, title/description, source and an external-link icon. Missing/failed covers use a music/link icon; they do not remove the destination or block clicking. Known app ID 202 is labeled as a share.
- Retain existing destination handling: external URLs use the application's validated external opener; existing supported album links continue their prior in-app route. No remote scripts, styles, frames or player embeds are inserted into the renderer. No new per-card metadata or playback requests are introduced.

## Verification And Limits

- 15 browser parser cases cover sibling/lazy/background covers, complete titles, descriptions/sources, music typing, absent covers, enriched-link preservation, unsafe URLs and retention of ordinary photos/videos.
- Four actual-view scenarios (1280/390px, light/dark) verify four native cards, failed-cover fallback, no card-cover leakage into the media gallery, no horizontal overflow and 16 exact mocked destination opens.
- Existing regression: 48 feed/space media-grid scenarios and 13 media-parser cases pass, including photo/video playback and layout behavior.
- Renderer TypeScript, complete repository lint/format checks and 12 desktop Qzone RPC/media tests pass. Existing URL-safety unit coverage now includes protocol-relative trusted images and rejected local/lookalike/credential-bearing destinations.
- An authorized, bounded comparison read three recent friend-feed responses via the existing WeQ credential path (16 returned entries). These did not contain the two screenshot article/song posts; their exact current markup and real-account rendering were not verified. No further history traversal, raw-response persistence, private media download or target-page fetch was performed. Credentials/raw responses remained in memory and were cleared; the temporary compiled read module was removed.
- Browser QA uses generated images and synthetic markup, not private post contents. Sources/results are in the existing Agents project's `work/ntqq-view-export-20261015/qzone-share-qa*`. All owned browsers closed normally.

Unknown server markup, absent metadata or unsupported cover origins may still require an additional exact sample. Missing metadata is not invented or scraped from the external target page. No new production/package build, installation, push or restarted-application acceptance is claimed by these checks.

## Development Reload

Renderer projection, React components and CSS only: Vite HMR can load the change. No main-process or QQ restart is required. Refresh the space view if an already-projected feed remains stale.
