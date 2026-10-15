# NTQQ viewing/export improvements

The real scheduled turn started at 2026-10-15 06:00:22 Beijing time in the existing dev worktree.
The rollout records `turn_trigger=automation_heartbeat_scheduled`, mode `default`,
and the first command at 06:00:34. This is execution evidence, not merely an
ACTIVE flag or a nominal schedule. After removal no automation remains on this
target chat. The post-deletion automation_runs query has no row and is not used
to infer that the heartbeat failed to run.
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
- Nine focused preview tests pass. Account-local profiles and independently
  scoped group-member/card lookups are reused; numeric placeholders do not
  override a resolved name, and malformed identities are ignored safely.
  Renderer type checking and production
  compilation pass. Playwright rendered the actual DialogHost with synthetic
  content in 18 desktop/mobile light/dark/light and error/warning/info cases;
  screenshots were inspected, with no page errors or horizontal overflow.
  These are isolated component checks, not a real-account QQ capture or a claim
  that every possible page/data combination was exercised.

## Implemented First Version

1. Conversation calendar with year/month selection, observed-day counts, Beijing
   day boundaries and first/latest dated sequenced anchors. Unknown/seq-less
   dates are not invented; seq-less records remain visible in the browse view.
2. Combined inclusive date, exact sender UID/UIN, category and case-insensitive
   text filters. Viewing uses a time/rowid cursor that also retains NULL-time and
   same-seq rows. Exports reuse the same predicate across formats; local media
   copying is selectable and HTML requests it. No additional cloud acquisition
   is started by this new filtered-export entry.
3. Common export-report JSON separates execution from content completeness,
   counts one message set rather than multiplying by format count, records
   rendered-model unknown/empty content, stage errors and specialised evidence.
   When backfill was actually scanned, bounded candidate sequence gaps are
   reported; gaps are not proof that server messages are missing. Unchecked
   roaming/media quality stays explicitly unverified. Reports are accessible
   from task controls and saved alongside plain files or within bundles.
4. Restarted tasks require explicit continuation. Completed formats are retained
   and SHA-256 checked; incomplete formats are regenerated, not appended at an
   unsafe byte offset. DB/WAL identity/size/mtime/ctime and option bindings reject
   changed sources or recipes; cached roaming content has a separate digest.
   This is format-level recovery, not a full historical SQLite snapshot or
   per-message/media-item checkpoint. Resource phases can run again. Pause and
   cancellation keep acquired partial outputs; deleting a task remains explicit.
5. Bounded preflight samples up to 100 matching rows in each of at most three
   selected conversations. Exact counts and lower bounds are distinguished;
   uncertain media/format overhead is not fabricated. It checks writable cache
   paths/free space, retains existing online/model capability checks, and checks
   capacity again at the actual save destination. Estimates are not guarantees.

The actual ChatRecordsModal/Calendar were exercised with a mock, local-only API
in desktop/mobile light/dark Playwright cases: combined filters, leap-day +08
anchors, preflight confirmation and matching export parameters. No real QQ
account was opened, exported, captured or changed in this validation.

Temporary QA/build orchestration lives in the existing private Agents project,
outside this checkout.
Generated browser fixtures/screenshots and compilation remain under desktop
dist/out; no new top-level project, archive entry or compatibility link was made.

Keep the product scoped to NTQQ viewing/export. Do not install, publish, push,
restart services, collect QQ data or read archive disks without fresh authority.
Existing qzone_export.ts, qzone_history.ts and qzone_history.test.ts modifications
pre-date this work and remain untouched. The known qzone history test failure
(missing published history directory) is not a newly introduced regression.
