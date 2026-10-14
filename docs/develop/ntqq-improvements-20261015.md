# NTQQ viewing/export improvements

Started at 2026-10-15 06:00 Beijing time in the existing dev worktree.
The one-shot chat automation fired and was removed to prevent another run.

## Prerequisite fixes

- Poke conversation previews now reuse the account-local profile resolver and
  exact UID/UIN name mappings. Embedded historical nicknames remain preferred;
  the account's own identity remains "you"; unmatched identities retain their
  original number. Main and hidden conversation lists both receive the mapping.
- The shared modal shell, generic dialog headings/body/controls, database-error
  menus, account-selection and statistics surfaces now use theme tokens in dark
  mode. Two inline black Ark-card values use the foreground token. Theme choices,
  accent colours and actual media/theme-preview artwork remain unchanged.
- Seven focused preview tests pass. Renderer type checking and production
  compilation pass. Playwright rendered the actual DialogHost with synthetic
  content in 18 desktop/mobile light/dark/light and error/warning/info cases;
  screenshots were inspected, with no page errors or horizontal overflow.
  These are isolated component checks, not a real-account QQ capture or a claim
  that every possible page/data combination was exercised.

## Next work, in order

1. Conversation date navigation.
2. Combined date/sender/type/keyword filters and filtered export.
3. Unified export completeness reports.
4. Source-bound persistent export resume.
5. Export preflight estimates and destination/capability checks.

Keep the product scoped to NTQQ viewing/export. Do not install, publish, push,
restart services, collect QQ data or read archive disks without fresh authority.
Existing qzone_export.ts, qzone_history.ts and qzone_history.test.ts modifications
pre-date this work and remain untouched. The known qzone history test failure
(missing published history directory) is not a newly introduced regression.
