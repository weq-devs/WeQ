# macOS Startup Online-Probe Stall, 2026-10-15

## Observed Failure

The reported startup view showed the chat-home shell with the default name/avatar rather than populated account data. The application log confirmed the account opened successfully. A two-second live `sample` of the development Electron main process at 15:09 Beijing time showed all 162 sampled main-thread stacks inside `nt_helper::detect::db_lock::probe_db_lock -> proc_pidfdinfo`. A bounded request to the existing loopback MCP endpoint also timed out. This establishes a blocked main process, not a media-preview rendering diagnosis or a missing account session.

Routine account monitoring synchronously called macOS `Platform.resolveQqPid`, which used the full native database-holder scan over every system process. A slow kernel open-file inspection therefore blocked the Electron event loop and prevented account/UI requests from completing. The existing native library was not modified or replaced by this fix.

## Change

- Added the optional `Platform.resolveQqPidAsync` path for routine account monitoring; other platforms retain the original synchronous resolver as a fallback.
- The macOS implementation asynchronously runs `pgrep -x QQ`, then `lsof -nP -a -p <QQ candidates> -F0pcn -- <canonical account database path>`. Neither command is launched through a shell. It does not scan all processes' open files.
- A PID is accepted only when NUL-delimited output supplies both the exact QQ process name and the exact canonical database path. A matching process name, a database WAL file, an unknown name or multiple matching QQ holders is not enough.
- The complete attempt has a two-second deadline and bounded output. On timeout only the spawned probe child is signaled. An unexited child remains registered, preventing repeated polls from accumulating stuck subprocesses. Same-target concurrent probes share a promise; another target is not inferred from its result.
- Monitor login/PID polling and explicit rkey refresh await this path. Generation checks after asynchronous resolution prevent late results from reviving an account after stop/switch.
- Full native holder enumeration used for explicit database-repair checks remains unchanged; this patch does not redefine repair safety or claim that every legacy synchronous caller has been migrated.

## Verification

- Platform suite: 23 tests pass, including four new parser/process-lifecycle tests. Covers exact paths/names, ambiguity, split UTF-8 chunks, candidate filtering, in-flight sharing, timeout, no accumulation of stuck children, missing files, spawn/exit failure and output limits.
- Service suite: 851 tests pass, including 28 monitor tests. Two new monitor tests cover preference for the asynchronous probe and a result arriving after stop. One existing manual-refresh test now waits for asynchronous PID resolution before rejecting its simulated scan; its failure/retry assertions remain intact.
- Platform and desktop-main TypeScript checks pass, as do changed-file Biome and `git diff --check`.
- A real read-only probe of the current account's local database path found the QQ holder in 1,126 ms. A 10 ms event-loop timer ticked 103 times during the operation. This validates asynchronous account attribution in an isolated Node invocation, not a complete restarted Electron GUI acceptance.
- Production `electron-vite build` passes with existing dynamic-import/deprecation warnings. No macOS App packaging, installation, native replacement or push occurred.

Temporary renderer-query diagnostics were removed without changing the application CSP; they did not produce a usable query-state capture. Their loopback diagnostic servers exited. No cache, credentials, account settings, chat contents or QQ process were cleared/modified. The main process was sampled, not terminated.

## Loading The Fix

This is a main-process/platform/service change. Restart the development WeQ to load the rebuilt main bundle; renderer HMR cannot replace an already-running synchronous native call. QQ does not need restarting. The stalled instance was not force-quit, and a full restarted-account GUI check remains pending.
