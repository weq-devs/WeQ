# Primary Tab State Retention

## Behavior

Switching the primary navigation tab no longer clears the message selection or contacts selection. Each primary tab keeps its own search text. First entry still follows the existing auto-selection policy; desktop WeQ does not automatically pick a conversation.

`RetainedTabs` lazily mounts visited panes and retains their component/DOM state. Hidden panes keep their last props until reactivation; the cache uses React render state so an interrupted concurrent transition cannot publish an unvisited pane. MainView uses this for main content and sidebars. QQ space continues to use its existing activity-aware retained workspace.

Each sidebar pane owns its scroll container; the shared sidebar container no longer has to switch one scroll position between different lists. Other nested scroll positions are retained within each pane. ChatPane keeps ownership of message-history anchors and follow-new-message behavior.

The relation graph ignores zero-size measurements while hidden and avoids restarting its layout for an unchanged size when shown again. Its existing canvas and camera are retained rather than recreated.

Explicit Back/close-detail actions still clear the corresponding detail. They do not erase the other primary tab's selection. Contact sub-tabs keep their existing semantics; this is not a new cross-restart persistence mechanism. MainView's existing account key discards this in-memory UI state when the opened account changes.

## Inactive Panes

- Hidden chat panes do not run edge-pagination/scroll positioning or multi-select/menu keyboard handlers.
- The main unread-marking path checks that the message view is visible, including after asynchronous unread lookup.
- Contacts and notices ignore Escape while inactive. Shared modals and custom composer portals are hidden and release overlay-layer registration without losing retained input state.
- Document event subscriptions are removed in layout effects when a pane becomes inactive, closing the interval between a committed tab switch and passive-effect cleanup.
- Primary rail navigation does not run composer outside-click dismissal before the tab switch. Explicit user dismissals retain their usual meaning.
- This does not globally pause already-running export/assistant jobs or all child-owned data subscriptions. Unvisited views are not mounted.

## Verification

Actual React controller, ChatShell, ChatPane, contacts sidebar, retained panes and shared Modal were exercised with synthetic data in four desktop/mobile light/dark cases. Checks cover selected conversation, composer DOM/draft, message reading position, contact-category expansion and sidebar scroll, independent search text and form state, mount counts, hidden modal/Escape isolation and account reset. Desktop cases also check that Escape in another tab cannot clear retained message multi-selection. The test waits for the committed visible pane, not the transitional hook-render snapshot.

Desktop main/preload/renderer typechecks and changed-file Biome checks pass. The existing desktop tests use two runners: the four Vitest suites pass 37 tests (including the separate reply-display tests); the five Node test files pass 28 tests under `tsx --test`. Using Vitest for the Node test files reports no Vitest suite; that is a runner mismatch, not a product test failure.

No real-account read-watermark writes or full-account GUI acceptance were performed. QA is kept in the existing local work project under `tab-retention-qa*`; no real QQ traffic is required.

## Reload

Renderer-only changes: development HMR can load this without restarting WeQ or QQ. UI state already lost before this implementation is not reconstructed. Closing/reopening the account or restarting the app intentionally starts a new in-memory workspace.
