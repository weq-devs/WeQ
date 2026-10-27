// @vitest-environment node
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthGate, AUTH_RESOURCE_LIMITS } from '../src/main/web/auth';

const gates: AuthGate[] = [];
afterEach(() => {
  for (const gate of gates.splice(0)) gate.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function fixture(
  limits: { maxSessions?: number; maxFailureRecords?: number; maxPendingLogins?: number } = {},
) {
  vi.useFakeTimers();
  const gate = new AuthGate({ token: 'synthetic', remote: false, ...limits });
  gates.push(gate);
  return gate;
}
function response() {
  let cookie = '';
  const res = {
    setHeader: (_key: string, value: string) => {
      cookie = value.split(';')[0]!;
    },
  } as unknown as ServerResponse;
  return { res, request: () => ({ headers: { cookie } }) as IncomingMessage };
}

it('无效容量不会悄悄关闭限制或留下清理任务', () => {
  vi.useFakeTimers();
  for (const value of [0, -1, NaN, Infinity, 1.5]) {
    for (const key of ['maxSessions', 'maxFailureRecords', 'maxPendingLogins'] as const)
      expect(() => new AuthGate({ token: 'synthetic', remote: false, [key]: value })).toThrow();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it('未再访问的过期会话与失败来源也会回收，正常活跃会话保持有效', async () => {
  const gate = fixture();
  const old = response(),
    live = response();
  await gate.login('synthetic', 'old', old.res);
  await gate.login('synthetic', 'live', live.res);
  await gate.login('wrong', 'failed', response().res);
  await vi.advanceTimersByTimeAsync(AUTH_RESOURCE_LIMITS.sessionTtlMs / 2);
  expect(gate.isAuthed(live.request())).toBe(true);
  await vi.advanceTimersByTimeAsync(
    AUTH_RESOURCE_LIMITS.sessionTtlMs / 2 + AUTH_RESOURCE_LIMITS.sweepMs,
  );
  expect(gate.diagnostics()).toMatchObject({ sessions: 1, failureRecords: 0 });
  expect(gate.isAuthed(old.request())).toBe(false);
  expect(gate.isAuthed(live.request())).toBe(true);
});

it('容量达到上限不淘汰有效登录，注销后可继续登录', async () => {
  const gate = fixture({ maxSessions: 1 });
  const live = response();
  await gate.login('synthetic', 'live', live.res);
  await expect(gate.login('synthetic', 'new', response().res)).rejects.toThrow('容量');
  expect(gate.isAuthed(live.request())).toBe(true);
  gate.logout(live.request(), response().res);
  expect(await gate.login('synthetic', 'new', response().res)).toBe(true);
});

it('失败来源溢出不删除原记录，也不靠换来源绕过退避；成功登录不清空溢出保护', async () => {
  const gate = fixture({ maxFailureRecords: 1 });
  await gate.login('wrong', 'known', response().res);
  const failed = gate.login('wrong', 'overflow-a', response().res);
  await vi.advanceTimersByTimeAsync(AUTH_RESOURCE_LIMITS.maxBackoffMs);
  expect(await failed).toBe(false);
  expect(gate.diagnostics()).toMatchObject({ failureRecords: 1, overflowActive: true });
  let retainedFinished = false;
  const retained = gate.login('wrong', 'known', response().res).then((value) => {
    retainedFinished = true;
    return value;
  });
  await vi.advanceTimersByTimeAsync(AUTH_RESOURCE_LIMITS.backoffBaseMs);
  expect(retainedFinished).toBe(true);
  expect(await retained).toBe(false);
  const success = gate.login('synthetic', 'overflow-b', response().res);
  await vi.advanceTimersByTimeAsync(AUTH_RESOURCE_LIMITS.maxBackoffMs);
  expect(await success).toBe(true);
  let settled = false;
  const again = gate.login('wrong', 'overflow-c', response().res).then((value) => {
    settled = true;
    return value;
  });
  await vi.advanceTimersByTimeAsync(AUTH_RESOURCE_LIMITS.maxBackoffMs - 1);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await again).toBe(false);
  await vi.advanceTimersByTimeAsync(
    AUTH_RESOURCE_LIMITS.failureTtlMs + AUTH_RESOURCE_LIMITS.sweepMs,
  );
  expect(gate.diagnostics()).toMatchObject({ failureRecords: 0, overflowActive: false });
});

it('等待登录有界，关闭会中止等待，关闭后的实例不能重新创建会话', async () => {
  const gate = fixture({ maxPendingLogins: 1 });
  await gate.login('wrong', 'known', response().res);
  const pending = gate.login('wrong', 'known', response().res).catch(() => false);
  await expect(gate.login('synthetic', 'new', response().res)).rejects.toThrow('繁忙');
  gate.close();
  expect(await pending).toBe(false);
  expect(gate.diagnostics()).toMatchObject({ sessions: 0, failureRecords: 0, pendingLogins: 0 });
  expect(vi.getTimerCount()).toBe(0);
  await expect(gate.login('synthetic', 'new', response().res)).rejects.toThrow();
});

it('一个撤销回调失败不阻断其他回调或服务关闭', async () => {
  const gate = fixture();
  const login = response();
  await gate.login('synthetic', 'live', login.res);
  const called = vi.fn();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  gate.watchSession(login.request(), () => {
    throw new Error('synthetic');
  });
  gate.watchSession(login.request(), called);
  expect(() => gate.close()).not.toThrow();
  expect(called).toHaveBeenCalledOnce();
  vi.restoreAllMocks();
});
