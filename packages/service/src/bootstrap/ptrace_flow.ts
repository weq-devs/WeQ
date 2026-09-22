/**
 * Linux unprivileged-inject flow, extracted so it is electron-free and unit
 * testable (same treatment as the db_repair pure logic).
 *
 * Injecting the hook into a live QQ process requires a ptrace attach, which
 * yama's ptrace_scope refuses by default for "same user, not a parent, not
 * already authorised". So the flow has three stages:
 *
 *   1. TRY DIRECT — with ptrace_scope=0 (or CAP_SYS_PTRACE) the attach just
 *      works: no dialog, no password.
 *   2. DENIED → HINT — the kernel refused (EPERM/EACCES), so ask the renderer
 *      to walk the user through disabling the protection (see
 *      `ptrace_hint.ts`).
 *   3. ESCALATE — the user would rather type a password than disable the
 *      protection: sudo elevates (the concrete escalation lives in the desktop
 *      app's `inject_elevation.ts`).
 *
 * `AppSettings.suppressPtraceHint` ("不再提醒") means ONLY "stop showing stage
 * 2's guidance dialog". It is NOT "skip the direct attempt and go straight to a
 * password". The earlier implementation short-circuited on it *before* the
 * direct attempt, so a user who had ever ticked the box could never get the
 * passwordless path again even after turning ptrace_scope off — every inject
 * popped a password dialog. This module pins the order: direct is always tried
 * first, and suppression only decides whether stage 2 is shown.
 */

import type { PtraceHintAnswer } from './inject';

/**
 * Outcome of one unprivileged direct inject: `null` means success, otherwise
 * the failure classification.
 *
 * `permissionDenied` marks the failures an elevated retry can actually fix —
 * the kernel refused the ptrace attach (EPERM/EACCES). Anything else (injector
 * not extracted, hook bind timeout, …) is escalated straight away without the
 * hint, matching the previous behaviour.
 */
export interface DirectInjectFailure {
  permissionDenied: boolean;
  message: string;
}

/** Side effects the flow needs (real implementations live in the desktop app). */
export interface PtraceInjectFlowDeps {
  /**
   * Structured log (same shape as `getLogger().info(message, context)`).
   * `context.event` carries the machine-readable event name, reusing the
   * existing `inject-*` / `ptrace-hint-*` vocabulary.
   */
  log(
    level: 'info' | 'warn',
    message: string,
    context: { event: string } & Record<string, unknown>,
  ): void;
  /** Unprivileged direct inject: null on success, classification on failure. */
  tryDirect(): Promise<DirectInjectFailure | null>;
  /**
   * Show the ptrace guidance dialog. Headless hosts degrade to
   * `{ choice: 'skip', password: '' }`.
   */
  askHint(): Promise<PtraceHintAnswer>;
  /** Escalate via password (empty string = not supplied; caller re-prompts). */
  escalate(password?: string): Promise<void>;
  /** Persist "don't ask again". */
  suppressHint(): void;
  /** Whether the user already ticked "don't ask again". */
  isHintSuppressed(): boolean;
}

/**
 * Run the unprivileged half of an inject (the escalation strategy is decided by
 * `deps.escalate`).
 *
 * The order IS the contract: **try direct → if denied, decide whether to show
 * the hint → otherwise escalate**. Whatever `isHintSuppressed()` returns, the
 * direct attempt always happens first — that is the fixed meaning of
 * "don't ask again", and the reason this module exists.
 */
export async function runUnprivilegedInject(deps: PtraceInjectFlowDeps): Promise<void> {
  // Direct first, always: "don't ask again" mutes the dialog, it must not skip
  // the passwordless path.
  const first = await deps.tryDirect();
  if (first === null) {
    // Logged so "why am I being asked for a password?" is answerable from the
    // logs alone: this line means the passwordless path was taken.
    deps.log('info', 'ptrace direct inject succeeded; no escalation needed', {
      event: 'inject-direct-ok',
    });
    return;
  }

  if (!first.permissionDenied) {
    // Not a kernel refusal (injector not extracted, hook bind timeout, …) —
    // an elevated retry can't fix it, but keep the existing behaviour: let the
    // escalation path surface the error.
    deps.log('warn', 'direct inject failed for a non-permission reason; escalating', {
      event: 'inject-direct-non-permission-failed',
      reason: first.message,
    });
    await deps.escalate();
    return;
  }

  if (deps.isHintSuppressed()) {
    deps.log('info', 'ptrace hint suppressed by user; escalating directly', {
      event: 'inject-hint-suppressed',
      reason: first.message,
    });
    await deps.escalate();
    return;
  }

  const answer = await deps.askHint();
  if (answer.choice === 'cancel') {
    deps.log('info', 'ptrace hint cancelled; inject aborted', {
      event: 'inject-hint-cancelled',
    });
    throw new Error('已取消授权，未注入 QQ 进程。');
  }
  if (answer.choice === 'retry') {
    const retry = await deps.tryDirect();
    if (retry === null) {
      deps.log('info', 'ptrace direct inject succeeded after retry; no escalation needed', {
        event: 'inject-direct-ok',
      });
      return;
    }
    if (retry.permissionDenied) {
      deps.log('warn', 'ptrace retry still permission-denied; escalating', {
        event: 'inject-direct-retry-denied',
      });
    }
    await deps.escalate(answer.password);
    return;
  }
  if (answer.choice === 'no-remind') {
    deps.suppressHint();
    deps.log('info', 'ptrace hint permanently suppressed', {
      event: 'ptrace-hint-suppressed',
    });
  }
  await deps.escalate(answer.password);
}
