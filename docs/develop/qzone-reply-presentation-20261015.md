# QQ Space Reply Recipient Display

Replies render as `author replies to recipient: body`: the automatic recipient is shown as the existing blue clickable name before the colon, not as an authored `@` in the body.

`qzoneReplyPresentation` is a renderer-only projection. It recognizes a leading structured recipient through exact reply-target identity, an explicit `who:1` marker, or an exact known parent identity in legacy replies. It does not guess by display names, strip plain-text `@name`, remove unrelated authored mentions, or override conflicting recipient metadata. Subsequent authored mentions remain in the body. Both expanded comments and resolved notification excerpts use the projection.

The existing recipient link continues to open the exact recipient UIN. Source comment objects, raw text and exported records are not rewritten.

Verification: six pure projection tests pass; four actual QzoneView desktop/mobile light/dark synthetic cases verify recipient placement, preserved authored mentions, blue links to the exact two test UINs, and the absence of the automatic recipient prefix from the resolved notification excerpt. No real QQ requests were made.

This is a renderer-only change and can use development HMR; WeQ and QQ do not need restarting.
