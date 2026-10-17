import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSqliteStub, closeAllFixtureDbs } from '@weq/testkit';
import type { AccountSession } from '@weq/account';
import * as atomic from '../src/common/atomic_write';
import {
  GapHistoryService,
  assertRoamingPageIdentity,
  type GapFetchedMessage,
  type GapFetchResult,
} from '../src/account/gap_history';
import { backfillConversationMessages } from '../src/account/export/msg_backfill';
import {
  RoamingBackfillManager,
  mergeRoamingIntervals,
  subtractRoamingIntervals,
  type RoamingBackfillDeps,
  type RoamingJobOptions,
  type RoamingTarget,
} from '../src/account/roaming_backfill';

const roots: string[] = [];
const managers: { manager: RoamingBackfillManager; path: string }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { manager, path } of managers.splice(0)) {
    manager.dispose();
    await RoamingBackfillManager.waitForIdle(path);
  }
  closeAllFixtureDbs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const target: RoamingTarget = { kind: 'group', conv: '12345', name: 'Synthetic group' };
const options = (overrides: Partial<RoamingJobOptions> = {}): RoamingJobOptions => ({
  targets: [target],
  beforeOldest: false,
  intervalMs: 500,
  maxRequests: 200,
  ...overrides,
});
function message(seq: number, peer = target): GapFetchedMessage {
  return {
    ...peer,
    msgId: `random-${seq}`,
    msgSeq: String(seq),
    senderUid: 'u_synthetic',
    senderUin: '10000',
    sendTime: '1700000000',
    ntSeqVerified: true,
    elements: [],
  };
}
function setup(seqs = [100n, 1n]) {
  const root = mkdtempSync(join(tmpdir(), 'weq-batch-roaming-'));
  roots.push(root);
  const path = join(root, 'tasks.json');
  const history = new GapHistoryService(
    createSqliteStub(),
    {} as AccountSession,
    () => {
      throw new Error('offline fixture');
    },
    join(root, 'cache.db'),
  );
  const fetch = vi.fn(
    async (peer: RoamingTarget, start: number, end: number): Promise<GapFetchResult> => ({
      ok: true,
      messages: Array.from({ length: end - start + 1 }, (_, i) => message(start + i, peer)),
      nextStartSeq: null,
      fetched: end - start + 1,
      networkRequested: true,
    }),
  );
  const deps: RoamingBackfillDeps = {
    source: 'synthetic-account:synthetic-source',
    listSeqWindow: vi.fn(async () => ({ seqs, below: null, above: null })),
    cached: (peer, start, end) => history.cached(peer.kind, peer.conv, start, end),
    fetch: async (peer, start, end, _signal, _interval, beforeRequest) => {
      const result = await fetch(peer, start, end);
      if (result.networkRequested !== false) beforeRequest();
      return result;
    },
    retain: (rows) => history.retainForBatch(rows),
    checkOnline: vi.fn(),
    onMessages: vi.fn(),
  };
  const make = (d = deps) => {
    const manager = new RoamingBackfillManager(path, d);
    managers.push({ manager, path });
    return manager;
  };
  const manager = make();
  const done = () => RoamingBackfillManager.waitForIdle(path);
  return { path, manager, deps, fetch, history, make, done };
}

describe('removed SDK transport', () => {
  it('rejects new SDK plans before reading sources or sending requests', async () => {
    const f = setup();
    await expect(
      f.manager.plan(options({ transport: 'native500', nativeBinding: 'a'.repeat(64) })),
    ).rejects.toThrow('SDK 历史通道已移除');
    expect(f.deps.listSeqWindow).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it('retains legacy tasks, hashes and in-flight windows without silently falling back', async () => {
    const f = setup();
    const legacy = await f.manager.plan(options());
    const ordinary = await f.manager.plan(options());
    const saved = JSON.parse(readFileSync(f.path, 'utf8'));
    const job = saved.jobs[0];
    job.options.transport = 'native500';
    job.options.nativeBinding = 'a'.repeat(64);
    job.optionsHash = createHash('sha256').update(JSON.stringify(job.options)).digest('hex');
    job.status = 'paused';
    job.inFlight = { target: 'group:12345', start: 70, end: 99, at: 123 };
    writeFileSync(f.path, JSON.stringify(saved));
    const before = readFileSync(f.path, 'utf8');
    const reloaded = f.make();
    expect(reloaded.list()).toHaveLength(2);
    expect(reloaded.list().find((item) => item.id === legacy.id)).toMatchObject({
      optionsHash: job.optionsHash,
      options: job.options,
      inFlight: job.inFlight,
    });
    expect(() => reloaded.start(legacy.id)).toThrow('SDK 历史通道已移除');
    expect(() => reloaded.start(legacy.id, true)).toThrow('SDK 历史通道已移除');
    expect(readFileSync(f.path, 'utf8')).toBe(before);
    expect(f.fetch).not.toHaveBeenCalled();
    reloaded.start(ordinary.id);
    await f.done();
    expect(f.fetch).toHaveBeenCalled();
    expect(reloaded.list().find((item) => item.id === legacy.id)).toMatchObject({
      optionsHash: job.optionsHash,
      inFlight: job.inFlight,
    });
  });
});

describe('unified SSO task compatibility', () => {
  it('rejects new legacy channel choices instead of silently changing their options', async () => {
    const f = setup();
    for (const transport of ['sso30', 'sso500'] as const)
      await expect(f.manager.plan(options({ transport }))).rejects.toThrow('历史通道已统一');
    expect(f.deps.listSeqWindow).not.toHaveBeenCalled();
  });
  it.each(['sso30', 'sso500'] as const)(
    'preserves old %s options, hashes and pending intervals',
    async (transport) => {
      const f = setup([5n, 1n]);
      const task = await f.manager.plan(options({ transport: 'sso' }));
      const saved = JSON.parse(readFileSync(f.path, 'utf8'));
      const old = saved.jobs[0];
      old.options.transport = transport;
      old.optionsHash = createHash('sha256').update(JSON.stringify(old.options)).digest('hex');
      writeFileSync(f.path, JSON.stringify(saved));
      const reloaded = f.make();
      expect(reloaded.list()[0]).toMatchObject({
        options: old.options,
        optionsHash: old.optionsHash,
        pendingSeqs: 3,
      });
      if (transport === 'sso500') {
        const before = readFileSync(f.path, 'utf8');
        expect(() => reloaded.start(task.id)).toThrow('聚合通道已移除');
        expect(() => reloaded.start(task.id, true)).toThrow('聚合通道已移除');
        expect(readFileSync(f.path, 'utf8')).toBe(before);
        expect(f.fetch).not.toHaveBeenCalled();
      } else {
        reloaded.start(task.id);
        await f.done();
        expect(reloaded.list()[0]).toMatchObject({
          status: 'completed',
          options: old.options,
          optionsHash: old.optionsHash,
        });
      }
    },
  );
});

describe('exact interval algebra', () => {
  it('merges overlapping/adjacent ranges and subtracts only observed points', () => {
    expect(
      mergeRoamingIntervals([
        { start: 4, end: 8 },
        { start: 1, end: 3 },
        { start: 7, end: 9 },
      ]),
    ).toEqual([{ start: 1, end: 9 }]);
    expect(
      subtractRoamingIntervals(
        [{ start: 1, end: 10 }],
        [
          { start: 2, end: 2 },
          { start: 8, end: 8 },
        ],
      ),
    ).toEqual([
      { start: 1, end: 1 },
      { start: 3, end: 7 },
      { start: 9, end: 10 },
    ]);
  });
  it('matches an enumerated oracle for fragmented queues', () => {
    for (let seed = 1; seed < 60; seed++) {
      const ranges = Array.from({ length: 10 }, (_, i) => ({
        start: ((seed * (i + 1)) % 40) + 1,
        end: ((seed * (i + 1)) % 40) + 4,
      }));
      const cuts = Array.from({ length: 7 }, (_, i) => ({
        start: ((seed * (i + 3)) % 40) + 1,
        end: ((seed * (i + 3)) % 40) + 3,
      }));
      const expand = (items: typeof ranges) =>
        new Set(
          items.flatMap((r) => Array.from({ length: r.end - r.start + 1 }, (_, i) => r.start + i)),
        );
      const input = expand(ranges),
        removed = expand(cuts);
      expect([...expand(subtractRoamingIntervals(ranges, cuts))].sort((a, b) => a - b)).toEqual(
        [...input].filter((n) => !removed.has(n)).sort((a, b) => a - b),
      );
    }
  });
});

describe('durable manual roaming jobs', () => {
  it('stops on a failed response without silently consuming that window', async () => {
    const f = setup();
    f.fetch.mockResolvedValue({
      ok: false,
      reason: 'error',
      message: 'synthetic server rejection',
      networkRequested: true,
    });
    const job = await f.manager.plan(options());
    f.manager.start(job.id);
    await f.done();
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.manager.list()[0]).toMatchObject({
      status: 'failed',
      requests: 1,
      errors: 1,
      remainingSeqs: 98,
      pendingSeqs: 98,
    });
    expect(f.manager.list()[0]?.attempts[0]).toMatchObject({ outcome: 'error', observed: 0 });
  });
  it('keeps source coverage separate from empty/unparsed content', async () => {
    const f = setup([5n, 1n]);
    const job = await f.manager.plan(options());
    f.manager.start(job.id);
    await f.done();
    expect(f.manager.list()[0]).toMatchObject({ remainingSeqs: 0, unparsedOrEmpty: 3 });
    expect(f.manager.list()[0]?.note).toContain('不代表全部历史完整');
  });
  it('plans without any online calls and does not materialize huge 30-seq window arrays', async () => {
    const f = setup([0xffffffffn, 1n]);
    const job = await f.manager.plan(options());
    expect(job.plannedSeqs).toBe(0xffffffff - 2);
    expect(JSON.parse(readFileSync(f.path, 'utf8')).jobs[0].targets[0].pending).toHaveLength(1);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.deps.checkOnline).not.toHaveBeenCalled();
  });
  it('keeps the unknown prefix opt-in and honors empty date windows bracketed by anchors', async () => {
    const f = setup([50n, 40n]);
    expect((await f.manager.plan(options())).plannedSeqs).toBe(9);
    expect((await f.manager.plan(options({ beforeOldest: true }))).plannedSeqs).toBe(48);
    f.deps.listSeqWindow = async () => ({ seqs: [], below: 10n, above: 20n });
    await f.manager.plan(options({ range: { start: 100, end: 200 } }));
    expect(JSON.parse(readFileSync(f.path, 'utf8')).jobs.at(-1).targets[0].ranges).toEqual([
      { start: 11, end: 19 },
    ]);
  });
  it('finishes all windows even when a legacy task has a one-request budget', async () => {
    const f = setup();
    const job = await f.manager.plan(options({ maxRequests: 1 }));
    f.manager.start(job.id);
    await f.done();
    expect(f.manager.list()[0]).toMatchObject({
      status: 'completed',
      requests: 4,
      remainingSeqs: 0,
      pendingSeqs: 0,
    });
    expect(f.fetch.mock.calls[0]?.slice(1, 3)).toEqual([70, 99]);
    expect(f.fetch).toHaveBeenCalledTimes(4);
    expect(f.fetch.mock.calls[1]?.slice(1, 3)).toEqual([40, 69]);
  });
  it('accepts more than one hundred conversations without a request budget', async () => {
    const f = setup([2n, 1n]);
    const { maxRequests: _legacyBudget, ...unlimited } = options();
    const job = await f.manager.plan({
      ...unlimited,
      targets: Array.from({ length: 125 }, (_, i) => ({
        kind: 'group' as const,
        conv: String(i + 1),
        name: `群 ${i + 1}`,
      })),
    });
    expect(job.targets).toHaveLength(125);
  });
  it('does not turn empty responses into coverage and retries unresolved intervals only explicitly', async () => {
    const f = setup([5n, 1n]);
    f.fetch.mockResolvedValue({
      ok: true,
      messages: [],
      fetched: 0,
      nextStartSeq: null,
      networkRequested: true,
    });
    const job = await f.manager.plan(options());
    f.manager.start(job.id);
    await f.done();
    expect(f.manager.list()[0]).toMatchObject({
      status: 'partial',
      remainingSeqs: 3,
      pendingSeqs: 0,
      observed: 0,
    });
    f.manager.start(job.id, true);
    await f.done();
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.manager.list()[0]?.remainingSeqs).toBe(3);
  });
  it('short pages subtract exact messages rather than filling examined holes', async () => {
    const f = setup([10n, 1n]);
    f.fetch.mockResolvedValue({
      ok: true,
      messages: [message(3), message(8), message(8)],
      fetched: 3,
      nextStartSeq: null,
      networkRequested: true,
    });
    const job = await f.manager.plan(options());
    f.manager.start(job.id);
    await f.done();
    expect(f.manager.list()[0]).toMatchObject({
      status: 'partial',
      observed: 2,
      remainingSeqs: 6,
      pendingSeqs: 0,
    });
    expect(JSON.parse(readFileSync(f.path, 'utf8')).jobs[0].targets[0].remaining).toEqual([
      { start: 2, end: 2 },
      { start: 4, end: 7 },
      { start: 9, end: 9 },
    ]);
  });
  it('does not send the complete interval queue on every UI status poll', async () => {
    const f = setup(Array.from({ length: 1000 }, (_, i) => BigInt(2000 - i * 2)));
    const job = await f.manager.plan(options());
    expect(JSON.parse(readFileSync(f.path, 'utf8')).jobs[0].targets[0].pending).toHaveLength(999);
    expect(job.targets[0]).not.toHaveProperty('pending');
    expect(JSON.stringify(f.manager.list()).length).toBeLessThan(5000);
  });
  it('uses durable cache evidence without network calls or counting cache hits as requests', async () => {
    const f = setup([5n, 1n]);
    await f.history.retainForBatch([message(2), message(3), message(4)]);
    f.deps.checkOnline = () => {
      throw Error('offline');
    };
    const job = await f.manager.plan(options());
    f.manager.start(job.id);
    await f.done();
    expect(f.manager.list()[0]).toMatchObject({
      status: 'completed',
      requests: 0,
      cacheWindows: 1,
      remainingSeqs: 0,
    });
    expect(f.fetch).not.toHaveBeenCalled();
    const cached = await f.history.cached('group', target.conv, 2, 4);
    f.deps.checkOnline = vi.fn();
    f.deps.cached = async () => [];
    f.fetch.mockResolvedValue({
      ok: true,
      messages: cached,
      fetched: 0,
      nextStartSeq: null,
      networkRequested: false,
    });
    const coalesced = await f.manager.plan(options());
    f.manager.start(coalesced.id);
    await f.done();
    expect(f.manager.list()[0]).toMatchObject({
      status: 'completed',
      requests: 0,
      cacheWindows: 1,
    });
  });
  it('pauses between windows and keeps in-flight successful records', async () => {
    const f = setup();
    let release!: () => void;
    const response = new Promise<void>((resolve) => {
      release = resolve;
    });
    const normal = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (...args) => {
      await response;
      return normal(...args);
    });
    const job = await f.manager.plan(options());
    f.manager.start(job.id);
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(1));
    expect(f.manager.pause(job.id).status).toBe('pausing');
    expect(() => f.manager.start(job.id)).toThrow('收尾');
    release();
    await f.done();
    expect(f.manager.list()[0]).toMatchObject({
      status: 'paused',
      observed: 30,
      remainingSeqs: 68,
    });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it('cancels without losing an in-flight response and does not leave a permanent finishing note', async () => {
    const f = setup();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const normal = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (...args) => {
      await pending;
      return normal(...args);
    });
    const job = await f.manager.plan(options());
    f.manager.start(job.id);
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledOnce());
    expect(f.manager.pause(job.id, true).status).toBe('cancelled');
    expect(() => f.manager.remove(job.id)).toThrow('收尾');
    release();
    await f.done();
    expect(f.manager.list()[0]).toMatchObject({ status: 'cancelled', observed: 30 });
    expect(f.manager.list()[0]?.note).not.toContain('等待');
    expect(() => f.manager.start(job.id)).toThrow('已结束');
    expect(await f.history.cached('group', target.conv, 70, 99)).toHaveLength(30);
  });
  it('reconciles an interrupted in-flight window from cache after a process restart', async () => {
    const f = setup([5n, 1n]);
    const job = await f.manager.plan(options());
    const saved = JSON.parse(readFileSync(f.path, 'utf8'));
    saved.jobs[0].status = 'running';
    saved.jobs[0].inFlight = { target: 'group:12345', start: 2, end: 4, at: 1 };
    writeFileSync(f.path, JSON.stringify(saved));
    await f.history.retainForBatch([message(2), message(3), message(4)]);
    const reopened = f.make();
    expect(reopened.list()[0]?.status).toBe('paused');
    expect(f.fetch).not.toHaveBeenCalled();
    reopened.start(job.id);
    await f.done();
    expect(reopened.list()[0]).toMatchObject({
      status: 'completed',
      remainingSeqs: 0,
      cacheWindows: 1,
    });
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it('rejects source/options mismatch without modifying the saved file', async () => {
    const f = setup();
    const job = await f.manager.plan(options());
    const foreign = f.make({ ...f.deps, source: 'another-account:another-source' });
    expect(() => foreign.start(job.id)).toThrow('来源或选项');
    const saved = JSON.parse(readFileSync(f.path, 'utf8'));
    saved.jobs[0].options.maxRequests = 999;
    const raw = JSON.stringify(saved);
    writeFileSync(f.path, raw);
    const altered = f.make();
    expect(() => altered.list()).toThrow('校验失败');
    expect(() => altered.start(job.id)).toThrow('校验失败');
    expect(readFileSync(f.path, 'utf8')).toBe(raw);
    saved.jobs[0].options.maxRequests = job.options.maxRequests;
    saved.jobs[0].targets[0].snapshot.count = -1;
    const badSnapshot = JSON.stringify(saved);
    writeFileSync(f.path, badSnapshot);
    expect(() => f.make().list()).toThrow('快照校验失败');
    expect(readFileSync(f.path, 'utf8')).toBe(badSnapshot);
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it('rejects loss of original source anchors without treating ordinary new rows as a source change', async () => {
    const f = setup([5n, 1n]);
    const job = await f.manager.plan(options());
    f.deps.listSeqWindow = async () => ({ seqs: [8n, 7n], below: null, above: null });
    f.manager.start(job.id);
    await f.done();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.manager.list()[0]).toMatchObject({
      status: 'failed',
      remainingSeqs: 3,
      pendingSeqs: 3,
    });
    expect(f.manager.list()[0]?.note).toContain('边界锚点');
  });
  it('does not advance coverage or a cursor when durable cache retention fails', async () => {
    const f = setup([5n, 1n]);
    f.deps.retain = async () => {
      throw Error('cache disk full');
    };
    const job = await f.manager.plan(options());
    f.manager.start(job.id);
    await f.done();
    expect(f.manager.list()[0]).toMatchObject({
      status: 'failed',
      observed: 0,
      remainingSeqs: 3,
      pendingSeqs: 3,
    });
    expect(f.manager.list()[0]?.inFlight).toBeDefined();
  });
  it('requires checkpoint persistence before dispatching any request', async () => {
    const f = setup();
    const job = await f.manager.plan(options());
    vi.spyOn(atomic, 'writeFileAtomicSync').mockImplementationOnce(() => {
      throw Error('checkpoint disk full');
    });
    expect(() => f.manager.start(job.id)).toThrow('checkpoint disk full');
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.manager.list()[0]?.status).toBe('planned');
    expect(JSON.parse(readFileSync(f.path, 'utf8')).jobs[0].status).toBe('planned');
  });
  it('rejects wrong-peer or unverified private rows and keeps the unresolved queue', async () => {
    for (const bad of [
      message(3, { ...target, conv: 'other' }),
      { ...message(3), msgSeq: '999' },
    ]) {
      const f = setup([5n, 1n]);
      f.fetch.mockResolvedValue({
        ok: true,
        messages: [bad],
        fetched: 1,
        nextStartSeq: null,
        networkRequested: true,
      });
      const job = await f.manager.plan(options());
      f.manager.start(job.id);
      await f.done();
      expect(f.manager.list()[0]).toMatchObject({
        status: 'failed',
        observed: 0,
        remainingSeqs: 3,
      });
    }
    const peer: RoamingTarget = { kind: 'c2c', conv: 'u_synthetic', name: 'Synthetic peer' };
    const f = setup([5n, 1n]);
    f.fetch.mockResolvedValue({
      ok: true,
      messages: [{ ...message(3, peer), ntSeqVerified: false }],
      fetched: 1,
      nextStartSeq: null,
      networkRequested: true,
    });
    const job = await f.manager.plan(options({ targets: [peer] }));
    f.manager.start(job.id);
    await f.done();
    expect(f.manager.list()[0]?.remainingSeqs).toBe(3);
  });
  it('preserves remaining work on offline failures and local arrivals reconcile without a new source', async () => {
    const f = setup([5n, 1n]);
    f.fetch.mockResolvedValue({
      ok: false,
      reason: 'offline',
      message: 'offline fixture',
      networkRequested: false,
    });
    const job = await f.manager.plan(options());
    f.manager.start(job.id);
    await f.done();
    expect(f.manager.list()[0]).toMatchObject({
      status: 'paused',
      remainingSeqs: 3,
      pendingSeqs: 3,
      requests: 0,
    });
    f.deps.listSeqWindow = async () => ({ seqs: [5n, 4n, 3n, 2n, 1n], below: null, above: null });
    f.manager.start(job.id);
    await f.done();
    expect(f.manager.list()[0]).toMatchObject({
      status: 'completed',
      remainingSeqs: 0,
      requests: 0,
    });
  });
  it('finishes every selected conversation and removal never deletes cached messages', async () => {
    const f = setup([5n, 1n]);
    const second = { ...target, conv: '67890' };
    const job = await f.manager.plan(options({ targets: [target, second] }));
    f.manager.start(job.id);
    await f.done();
    expect(f.manager.list()[0]).toMatchObject({
      status: 'completed',
      observed: 6,
      remainingSeqs: 0,
    });
    f.manager.remove(job.id);
    expect(f.manager.list()).toEqual([]);
    expect(await f.history.cached('group', target.conv, 2, 4)).toHaveLength(3);
  });
});

describe('existing export integration with the shared queue', () => {
  it('does not count cache hits or queue time as online requests/slow network', async () => {
    const onRateLimited = vi.fn();
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(9000);
    const result = await backfillConversationMessages({
      kind: 'group',
      conv: target.conv,
      listSeqWindow: async () => ({ seqs: [5n, 1n], below: null, above: null }),
      fetch: async () => ({
        ok: true,
        messages: [message(2)],
        fetched: 0,
        nextStartSeq: null,
        networkRequested: false,
        networkDurationMs: 0,
      }),
      onRateLimited,
    });
    expect(result.requests).toBe(0);
    expect(onRateLimited).not.toHaveBeenCalled();
  });
  it('counts ordinary server errors as failures rather than silently dropping them', async () => {
    const result = await backfillConversationMessages({
      kind: 'group',
      conv: target.conv,
      listSeqWindow: async () => ({ seqs: [5n, 1n], below: null, above: null }),
      fetch: async () => ({
        ok: false,
        reason: 'error',
        message: 'synthetic failure',
        networkRequested: true,
      }),
    });
    expect(result.windowErrors).toBe(1);
    expect(result.requests).toBe(1);
  });
});

describe('strict roaming response identity', () => {
  const decoded = (patch: Record<string, unknown> = {}) =>
    ({
      head: { sequence: 3, ntMsgSeq: 3, timestamp: 1700000000 },
      sender: { uid: 'u_peer', uin: 20000 },
      session: { uid: 'u_self', uin: 10000 },
      ...patch,
    }) as Parameters<typeof assertRoamingPageIdentity>[3];
  it('accepts incoming and outgoing private messages for the exact peer and own account', () => {
    expect(() =>
      assertRoamingPageIdentity('c2c', 'u_peer', '10000', decoded(), 2, 4),
    ).not.toThrow();
    expect(() =>
      assertRoamingPageIdentity(
        'c2c',
        'u_peer',
        '10000',
        decoded({
          sender: { uid: 'u_self', uin: 10000 },
          session: { uid: 'u_peer', uin: 20000 },
        }),
        2,
        4,
      ),
    ).not.toThrow();
  });
  it('rejects another own account, unrelated peer, legacy seq and out-of-window records', () => {
    expect(() => assertRoamingPageIdentity('c2c', 'u_peer', '99999', decoded(), 2, 4)).toThrow();
    expect(() => assertRoamingPageIdentity('c2c', 'u_other', '10000', decoded(), 2, 4)).toThrow();
    expect(() =>
      assertRoamingPageIdentity(
        'c2c',
        'u_peer',
        '10000',
        decoded({ head: { sequence: 3, timestamp: 1 } }),
        2,
        4,
      ),
    ).toThrow();
    expect(() => assertRoamingPageIdentity('c2c', 'u_peer', '10000', decoded(), 4, 5)).toThrow();
  });
  it('requires an exact group session instead of trusting the requested conv label', () => {
    expect(() =>
      assertRoamingPageIdentity('group', '10000', '20000', decoded(), 2, 4),
    ).not.toThrow();
    expect(() => assertRoamingPageIdentity('group', '99999', '20000', decoded(), 2, 4)).toThrow();
  });
});
