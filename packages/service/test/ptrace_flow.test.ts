/**
 * Linux 无特权注入流程的顺序回归。
 *
 * 这里钉住的是「不再提醒」的语义边界：它只静音引导弹窗，**不能**跳过直连注入。
 * 早期实现把 `suppressPtraceHint` 当成短路条件写在直连之前，结果是勾过一次的用户
 * 即使把 ptrace_scope 关掉也永远拿不到免密注入、每次都被要密码（用户实测复现）。
 *
 * 全假依赖，不碰 native / 真实 sudo / 配置：只记调用序列，断言顺序与分支。
 */

import { describe, expect, it } from 'vitest';
import {
  runUnprivilegedInject,
  type DirectInjectFailure,
  type PtraceInjectFlowDeps,
} from '../src/bootstrap/ptrace_flow';

interface Harness {
  deps: PtraceInjectFlowDeps;
  /** 按发生顺序记下各动作，断言顺序用。 */
  calls: string[];
  /** 传给 `escalate` 的密码（按调用顺序）。 */
  passwords: (string | undefined)[];
  suppressed: boolean;
}

/**
 * 造一个可控的流程环境。
 * @param direct 直连注入的结果序列，逐次消费（跑完还在调 → 抛错，防测试写错）。
 * @param answer 引导弹窗的回答。
 */
function harness(
  direct: (DirectInjectFailure | null)[],
  answer: { choice: 'retry' | 'no-remind' | 'skip' | 'cancel'; password?: string } = {
    choice: 'skip',
  },
  suppressed = false,
): Harness {
  const calls: string[] = [];
  const passwords: (string | undefined)[] = [];
  let i = 0;
  const state = { suppressed };

  const deps: PtraceInjectFlowDeps = {
    log: (level, _message, context) => {
      calls.push(`log:${level}:${context.event}`);
    },
    tryDirect: async () => {
      calls.push('tryDirect');
      if (i >= direct.length) throw new Error('tryDirect 调用次数超出预期');
      return direct[i++] ?? null;
    },
    askHint: async () => {
      calls.push('askHint');
      return { choice: answer.choice, password: answer.password ?? '' };
    },
    escalate: async (password) => {
      calls.push('escalate');
      passwords.push(password);
    },
    suppressHint: () => {
      calls.push('suppressHint');
      state.suppressed = true;
    },
    isHintSuppressed: () => state.suppressed,
  };

  return {
    deps,
    calls,
    passwords,
    get suppressed() {
      return state.suppressed;
    },
  };
}

const DENIED: DirectInjectFailure = { permissionDenied: true, message: 'EPERM' };
const OTHER: DirectInjectFailure = { permissionDenied: false, message: 'hook bind timeout' };

describe('runUnprivilegedInject 顺序', () => {
  it('直连成功时不出弹窗、不提权，并留下可诊断的日志', async () => {
    const h = harness([null]);
    await runUnprivilegedInject(h.deps);
    expect(h.calls).toEqual(['tryDirect', 'log:info:inject-direct-ok']);
    expect(h.passwords).toHaveLength(0);
  });

  it('已勾「不再提醒」时仍然先试直连，成功就免密', async () => {
    // 这就是用户踩到的那个坑：抑制不该短路直连。
    const h = harness([null], { choice: 'skip' }, /* suppressed */ true);
    await runUnprivilegedInject(h.deps);
    expect(h.calls).toEqual(['tryDirect', 'log:info:inject-direct-ok']);
    expect(h.passwords).toHaveLength(0);
  });

  it('已勾「不再提醒」且直连被拒：不弹窗，直接提权', async () => {
    const h = harness([DENIED], { choice: 'skip' }, true);
    await runUnprivilegedInject(h.deps);
    expect(h.calls).toEqual(['tryDirect', 'log:info:inject-hint-suppressed', 'escalate']);
  });

  it('未勾「不再提醒」且直连被拒：先弹引导', async () => {
    const h = harness([DENIED], { choice: 'skip', password: 'pw' });
    await runUnprivilegedInject(h.deps);
    expect(h.calls).toEqual(['tryDirect', 'askHint', 'escalate']);
    expect(h.passwords).toEqual(['pw']);
  });

  it('引导里「重新尝试」且这次直连成功：不再提权', async () => {
    const h = harness([DENIED, null], { choice: 'retry' });
    await runUnprivilegedInject(h.deps);
    expect(h.calls).toEqual(['tryDirect', 'askHint', 'tryDirect', 'log:info:inject-direct-ok']);
    expect(h.passwords).toHaveLength(0);
  });

  it('引导里「重新尝试」但仍被拒：提权并复用弹窗里的密码', async () => {
    const h = harness([DENIED, DENIED], { choice: 'retry', password: 'pw' });
    await runUnprivilegedInject(h.deps);
    expect(h.calls).toEqual([
      'tryDirect',
      'askHint',
      'tryDirect',
      'log:warn:inject-direct-retry-denied',
      'escalate',
    ]);
    expect(h.passwords).toEqual(['pw']);
  });

  it('引导里「不再提醒」：写抑制标记再提权', async () => {
    const h = harness([DENIED], { choice: 'no-remind', password: 'pw' });
    await runUnprivilegedInject(h.deps);
    expect(h.calls).toEqual([
      'tryDirect',
      'askHint',
      'suppressHint',
      'log:info:ptrace-hint-suppressed',
      'escalate',
    ]);
    expect(h.suppressed).toBe(true);
    expect(h.passwords).toEqual(['pw']);
  });

  it('引导里关闭弹窗（cancel）：中止且不提权', async () => {
    const h = harness([DENIED], { choice: 'cancel' });
    await expect(runUnprivilegedInject(h.deps)).rejects.toThrow('已取消授权');
    expect(h.calls).toEqual(['tryDirect', 'askHint', 'log:info:inject-hint-cancelled']);
    expect(h.passwords).toHaveLength(0);
  });

  it('非权限类失败：不弹引导，直接提权', async () => {
    const h = harness([OTHER]);
    await runUnprivilegedInject(h.deps);
    expect(h.calls).toEqual([
      'tryDirect',
      'log:warn:inject-direct-non-permission-failed',
      'escalate',
    ]);
  });
});
