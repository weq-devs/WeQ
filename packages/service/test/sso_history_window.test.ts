import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSqliteStub, closeAllFixtureDbs } from '@weq/testkit';
import { decode, encode, GetGroupHistory, GetC2cHistory } from '@weq/protocol';
import { GapHistoryService } from '../src/account/gap_history';
import { RoamingBackfillManager, type RoamingTarget } from '../src/account/roaming_backfill';
import * as atomic from '../src/common/atomic_write';

vi.mock('../src/common/roaming_request_queue', () => ({
  withRoamingRequest: async (
    operation: () => Promise<unknown>,
    options: { signal?: AbortSignal },
  ) => {
    options.signal?.throwIfAborted();
    return operation();
  },
}));
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
const group: RoamingTarget = { kind: 'group', conv: '12345', name: 'Synthetic protocol group' };
function fixture(target = group, duplicateAt?: number, twinAt?: number) {
  const root = mkdtempSync(join(tmpdir(), 'weq-sso-window-'));
  roots.push(root);
  const sql = createSqliteStub();
  let pid = 42;
  const response = (bytes: Buffer) => {
    const req = decode(
      target.kind === 'group' ? GetGroupHistory.reqSchema : GetC2cHistory.reqSchema,
      bytes,
    ) as {
      info?: { startSequence: number; endSequence: number };
      startSequence?: number;
      endSequence?: number;
    };
    const start = req.info?.startSequence ?? req.startSequence!;
    const end = req.info?.endSequence ?? req.endSequence!;
    expect(end - start + 1).toBeLessThanOrEqual(30);
    const rows = Array.from({ length: end - start + 1 }, (_, i) => start + i)
      .flatMap((seq) =>
        Array.from({ length: seq === duplicateAt || seq === twinAt ? 2 : 1 }, (_, id) => ({
          responseHead: {
            fromUin: 10001,
            fromUid: target.kind === 'group' ? 'u_sender' : target.conv,
            toUin: 10000,
            toUid: 'u_self',
            ...(target.kind === 'group' ? { grp: { groupUin: Number(target.conv) } } : {}),
          },
          contentHead: {
            sequence: target.kind === 'group' ? seq : 50000 + seq,
            ntMsgSeq: target.kind === 'c2c' ? seq : undefined,
            // twinAt：同 seq 两条携带**完全相同的** newId/msgId —— 私聊通话记录挂靠
            // 宿主消息时服务端就是这么回的（复用宿主的序号与消息 ID）。
            newId: 9007199254740993000n + BigInt(seq) * 2n + (seq === twinAt ? 0n : BigInt(id)),
            msgId: seq + 10 + (seq === twinAt ? 0 : id),
            timestamp: 1700000000,
          },
          body: { richText: { elems: [{ text: { str: 'Synthetic protocol history' } }] } },
        })),
      )
      .slice(-30);
    return Buffer.from(
      encode(
        target.kind === 'group' ? GetGroupHistory.respSchema : GetC2cHistory.respSchema,
        target.kind === 'group'
          ? {
              body: {
                groupUin: Number(target.conv),
                startSequence: rows[0]!.contentHead.sequence,
                endSequence: end,
                messages: rows,
              },
            }
          : { friendUid: target.conv, messages: rows },
      ),
    );
  };
  const sendPacket = vi.fn(async (_pid: number, _command: string, body: Buffer) => response(body));
  const nt = { ...sql, sendPacket };
  const history = new GapHistoryService(
    nt,
    { context: { uin: '10000' } } as never,
    () => pid,
    join(root, 'cache.db'),
  );
  const steps: { messages: { msgSeq: string; msgId: string }[]; network: boolean }[] = [];
  const beforeRequest = vi.fn(() => true);
  const hooks = {
    beforeRequest,
    completed: async (step: (typeof steps)[number]) => {
      steps.push(step);
    },
  };
  const fetch = async (start = 471, end = 500, signal = new AbortController().signal) => {
    const result = await history.fetch(target.kind, target.conv, start, end, {
      signal,
      intervalMs: 500,
      strictIdentity: true,
      beforeRequest: hooks.beforeRequest,
    });
    if (result.ok)
      await hooks.completed({
        messages: result.messages,
        network: result.networkRequested === true,
      });
    return result;
  };
  const path = join(root, 'tasks.json');
  const manager = new RoamingBackfillManager(path, {
    source: 'synthetic-protocol-account',
    listSeqWindow: async () => ({ seqs: [501n, 0n], below: null, above: null }),
    cached: (peer, start, end) => history.cached(peer.kind, peer.conv, start, end),
    fetch: (peer, start, end, signal, interval, beforeRequest) =>
      history.fetch(peer.kind, peer.conv, start, end, {
        signal,
        intervalMs: interval,
        strictIdentity: true,
        beforeRequest,
      }),
    retain: (rows) => history.retainForBatch(rows),
    checkOnline: () => {},
  });
  managers.push({ manager, path });
  return {
    nt,
    history,
    sendPacket,
    response,
    fetch,
    hooks,
    steps,
    manager,
    path,
    cachePath: join(root, 'cache.db'),
    changePid: () => {
      pid++;
    },
    done: () => RoamingBackfillManager.waitForIdle(path),
    plan: (budget = 200) =>
      manager.plan({
        transport: 'sso',
        targets: [target],
        beforeOldest: true,
        intervalMs: 500,
        maxRequests: budget,
      }),
  };
}

function withIncompleteSlot(f: ReturnType<typeof fixture>, sequence = 250, wrongPeer = false) {
  f.sendPacket.mockImplementation(async (_pid, _command, body) => {
    const response = decode(GetGroupHistory.respSchema, f.response(body)) as {
      body: {
        messages: { responseHead: unknown; contentHead: { sequence: number }; body: unknown }[];
      };
    };
    const index = response.body.messages.findIndex((row) => row.contentHead.sequence === sequence);
    if (index >= 0)
      response.body.messages[index] = {
        responseHead: { grp: { groupUin: wrongPeer ? 99999 : Number(group.conv) } },
        contentHead: { sequence, msgType: 82 } as { sequence: number },
        body: { richText: { elems: [{ text: { str: 'Synthetic incomplete observation' } }] } },
      };
    return Buffer.from(encode(GetGroupHistory.respSchema, response));
  });
}

describe('shared SSO physical windows', () => {
  it('does not dispatch when the durable physical reservation cannot be saved', async () => {
    const f = fixture();
    const job = await f.plan();
    const write = atomic.writeFileAtomicSync;
    vi.spyOn(atomic, 'writeFileAtomicSync').mockImplementation((path, data) => {
      if (path === f.path && JSON.parse(String(data)).jobs[0].inFlight)
        throw Error('synthetic reservation disk failure');
      return write(path, data);
    });
    f.manager.start(job.id);
    await f.done();
    expect(f.sendPacket).not.toHaveBeenCalled();
    expect(f.manager.list()[0]).toMatchObject({
      status: 'failed',
      requests: 0,
      checkedWindows: 0,
      remainingSeqs: 500,
    });
  });
  it('retains incomplete slots separately without counting them as genuine messages', async () => {
    const f = fixture();
    withIncompleteSlot(f);
    const page = await f.fetch(241, 270);
    if (!page.ok) throw Error(page.message);
    expect(page).toMatchObject({ networkRequested: true, unresolvedRecords: 1 });
    expect(page.messages).toHaveLength(29);
    expect(page.messages.some((row) => row.msgSeq === '250')).toBe(false);
    expect(await f.history.cachedForExport('group', group.conv)).toHaveLength(29);
    const observed = await f.nt.executeSql(
      f.cachePath,
      'SELECT reason,protocol_raw FROM protocol_gap_observation',
      null,
    );
    expect(observed).toHaveLength(1);
    expect(observed[0]![0]).toBe('missing_message_identity');
    expect(Buffer.from(String(observed[0]![1]), 'base64').length).toBeGreaterThan(0);
  });
  it('keeps incomplete observations unresolved in durable job coverage', async () => {
    const f = fixture();
    withIncompleteSlot(f);
    const job = await f.plan();
    f.manager.start(job.id);
    await f.done();
    expect(f.manager.list()[0]).toMatchObject({
      status: 'partial',
      observed: 499,
      remainingSeqs: 1,
      pendingSeqs: 0,
    });
    expect(await f.history.cached('group', group.conv, 250, 250)).toHaveLength(0);
  });
  it('does not quarantine a wrong-peer slot or checkpoint a failed observation write', async () => {
    const wrong = fixture();
    withIncompleteSlot(wrong, 490, true);
    expect(await wrong.fetch()).toMatchObject({
      ok: false,
      message: expect.stringContaining('会话或 NT 序号不一致'),
    });
    expect(wrong.steps).toHaveLength(0);
    const failed = fixture();
    withIncompleteSlot(failed, 490);
    const write = failed.nt.executeSqlWrite;
    failed.nt.executeSqlWrite = vi.fn(async (...args: Parameters<typeof write>) => {
      if (args[1].includes('INSERT OR IGNORE INTO protocol_gap_observation'))
        throw Error('synthetic observation write failure');
      return write(...args);
    });
    expect(await failed.fetch()).toMatchObject({
      ok: false,
      message: expect.stringContaining('synthetic observation write failure'),
    });
    expect(failed.steps).toHaveLength(0);
    expect(await failed.history.cachedForExport('group', group.conv)).toHaveLength(0);
  });
  it('reconciles exact cross-format IDs with zero random without dropping other IDs', async () => {
    const f = fixture();
    await f.fetch(1, 1);
    const original = (await f.history.cached('group', group.conv, 1, 1))[0]!;
    const protocol = { ...original, msgRandom: '0', sourceFormat: 'protocol' as const };
    const other = { ...protocol, msgId: (BigInt(protocol.msgId) + 1n).toString() };
    await f.history.retainForBatch([
      protocol,
      other,
      { ...protocol, sourceFormat: 'native', nativeRaw: { elements: [] } },
    ]);
    const rows = await f.history.cached('group', group.conv, 1, 1);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.msgId === protocol.msgId)?.sourceFormat).toBe('native');
    expect(rows.find((row) => row.msgId === other.msgId)?.sourceFormat).toBe('protocol');
  });
  it('reads only one 30-seq window even when the requested range is much larger', async () => {
    const f = fixture();
    const page = await f.fetch(1, 500);
    if (!page.ok) throw Error(page.message);
    expect(page).toMatchObject({ networkRequested: true, nextStartSeq: 31 });
    expect(page.messages).toHaveLength(30);
    expect(f.sendPacket).toHaveBeenCalledOnce();
    expect(
      page.messages.every((row) => row.sourceFormat === 'protocol' && Boolean(row.protocolRaw)),
    ).toBe(true);
    f.sendPacket.mockClear();
    expect(await f.fetch(1, 500)).toMatchObject({ networkRequested: false, nextStartSeq: 31 });
    expect(f.sendPacket).not.toHaveBeenCalled();
  });
  it('retains same-seq different IDs through the ordinary gap path, cache and export', async () => {
    const f = fixture(group, 1);
    const page = await f.fetch(1, 29);
    if (!page.ok) throw Error(page.message);
    expect(page.messages).toHaveLength(30);
    expect(page.messages.filter((row) => row.msgSeq === '1')).toHaveLength(2);
    expect(await f.history.cachedForExport('group', group.conv)).toHaveLength(30);
  });
  it('dedupes a private call record that reuses the host message identity', async () => {
    const target: RoamingTarget = { kind: 'c2c', conv: 'u_peer', name: 'Synthetic private peer' };
    const f = fixture(target, undefined, 5);
    const page = await f.fetch(1, 10);
    // 修复前：整窗抛「纯协议历史响应包含重复消息标识。」，10 条里一条都拿不到。
    if (!page.ok) throw Error(page.message);
    expect(page).toMatchObject({ networkRequested: true, unresolvedRecords: 1 });
    expect(page.messages).toHaveLength(10);
    expect(page.messages.filter((row) => row.msgSeq === '5')).toHaveLength(1);
    expect(page.messages.every((row) => row.ntSeqVerified)).toBe(true);
    const observed = await f.nt.executeSql(
      f.cachePath,
      'SELECT reason,protocol_raw FROM protocol_gap_observation',
      null,
    );
    expect(observed).toHaveLength(1);
    expect(observed[0]![0]).toBe('duplicate_message_identity');
    expect(Buffer.from(String(observed[0]![1]), 'base64').length).toBeGreaterThan(0);
  });
  it('keeps same-seq different identities while only observed duplicates are deduped', async () => {
    const f = fixture(group, 1);
    const page = await f.fetch(1, 29);
    if (!page.ok) throw Error(page.message);
    // 同 seq 不同 ID 仍然两条都留，且不该产生任何观察记录。
    expect(page.messages).toHaveLength(30);
    expect(page.messages.filter((row) => row.msgSeq === '1')).toHaveLength(2);
    expect(page.unresolvedRecords).toBe(0);
    const observed = await f.nt.executeSql(
      f.cachePath,
      'SELECT reason FROM protocol_gap_observation',
      null,
    );
    expect(observed).toHaveLength(0);
  });
  it('uses verified NT numbering for private physical windows', async () => {
    const target: RoamingTarget = { kind: 'c2c', conv: 'u_peer', name: 'Synthetic private peer' };
    const f = fixture(target);
    const first = await f.fetch(1, 60),
      second = await f.fetch(31, 60);
    if (!first.ok || !second.ok) throw Error('Expected verified windows');
    expect(first.nextStartSeq).toBe(31);
    expect([...first.messages, ...second.messages]).toHaveLength(60);
    expect(
      [...first.messages, ...second.messages].every(
        (row) => row.ntSeqVerified && Number(row.msgSeq) <= 60,
      ),
    ).toBe(true);
  });
  it('persists the physical request reservation before sending any bytes', async () => {
    const f = fixture();
    f.sendPacket.mockImplementation(async (_pid, _cmd, body) => {
      const saved = JSON.parse(readFileSync(f.path, 'utf8')).jobs[0];
      expect(saved.requests).toBe(saved.checkedWindows + 1);
      expect(saved.inFlight).toMatchObject({ start: expect.any(Number), end: expect.any(Number) });
      if (saved.requests === 1) expect(saved.inFlight).toMatchObject({ start: 471, end: 500 });
      return f.response(body);
    });
    const job = await f.plan(1);
    f.manager.start(job.id);
    await f.done();
    expect(f.sendPacket).toHaveBeenCalledTimes(job.estimatedWindows);
    expect(f.manager.list()[0]).toMatchObject({
      requests: job.estimatedWindows,
      checkedWindows: job.estimatedWindows,
      status: 'completed',
    });
  });
  it('rejects process changes before accepting or persisting a response', async () => {
    const f = fixture();
    f.sendPacket.mockImplementation(async (_pid, _cmd, body) => {
      f.changePid();
      return f.response(body);
    });
    expect(await f.fetch()).toMatchObject({
      ok: false,
      unknown: true,
      message: expect.stringContaining('QQ 会话已变化'),
    });
    expect(f.steps).toHaveLength(0);
    expect(await f.history.cachedForExport('group', group.conv)).toHaveLength(0);
  });
  it('rejects a group response explicitly addressed to another account', async () => {
    const f = fixture();
    f.sendPacket.mockImplementationOnce(async (_pid, _command, body) => {
      const response = decode(GetGroupHistory.respSchema, f.response(body)) as {
        body: { messages: { responseHead: { toUin?: number } }[] };
      };
      response.body.messages[0]!.responseHead.toUin = 99999;
      return Buffer.from(encode(GetGroupHistory.respSchema, response));
    });
    expect(await f.fetch()).toMatchObject({
      ok: false,
      message: expect.stringContaining('响应账号不一致'),
    });
    expect(f.steps).toHaveLength(0);
    expect(await f.history.cachedForExport('group', group.conv)).toHaveLength(0);
  });
  it.each([undefined, 0])('retains group records with an unset recipient (%s)', async (toUin) => {
    const f = fixture();
    f.sendPacket.mockImplementationOnce(async (_pid, _command, body) => {
      const response = decode(GetGroupHistory.respSchema, f.response(body)) as {
        body: { messages: { responseHead: { toUin?: number } }[] };
      };
      response.body.messages[0]!.responseHead.toUin = toUin;
      return Buffer.from(encode(GetGroupHistory.respSchema, response));
    });
    const page = await f.fetch(1, 30);
    if (!page.ok) throw Error(page.message);
    expect(page.messages).toHaveLength(30);
    expect(page.messages.every((row) => Boolean(row.protocolRaw))).toBe(true);
    expect(f.steps).toHaveLength(1);
    expect(await f.history.cachedForExport('group', group.conv)).toHaveLength(30);
  });
  it('counts and checkpoints every physical read without enforcing the legacy budget', async () => {
    const f = fixture();
    const job = await f.plan(2);
    f.manager.start(job.id);
    await f.done();
    expect(f.manager.list()[0]).toMatchObject({
      status: 'completed',
      requests: job.estimatedWindows,
      checkedWindows: job.estimatedWindows,
    });
    expect(f.sendPacket).toHaveBeenCalledTimes(job.estimatedWindows);
    expect(JSON.parse(readFileSync(f.path, 'utf8')).jobs[0].inFlight).toBeUndefined();
  });
  it('does not checkpoint or publish a physical response whose cache write fails', async () => {
    const f = fixture();
    const write = f.nt.executeSqlWrite;
    f.nt.executeSqlWrite = vi.fn(async (...args: Parameters<typeof write>) => {
      if (args[1].includes('INSERT OR REPLACE INTO protocol_gap_msg'))
        throw Error('synthetic disk failure');
      return write(...args);
    });
    expect(await f.fetch()).toMatchObject({
      ok: false,
      unknown: true,
      message: expect.stringContaining('synthetic disk failure'),
    });
    expect(f.steps).toHaveLength(0);
    expect(await f.history.cachedForExport('group', group.conv)).toHaveLength(0);
  });
  it('pauses without losing a verified in-flight small window or dispatching the next one', async () => {
    const f = fixture();
    let notify!: () => void;
    const entered = new Promise<void>((resolve) => {
      notify = resolve;
    });
    let release!: () => void;
    f.sendPacket.mockImplementationOnce(async (_pid, _command, body) => {
      notify();
      return new Promise<Buffer>((resolve) => {
        release = () => resolve(f.response(body));
      });
    });
    const job = await f.plan();
    f.manager.start(job.id);
    await entered;
    f.manager.pause(job.id);
    release();
    await f.done();
    expect(f.manager.list()[0]).toMatchObject({ status: 'paused', requests: 1, checkedWindows: 1 });
    expect(f.sendPacket).toHaveBeenCalledOnce();
    expect(await f.history.cachedForExport('group', group.conv)).toHaveLength(30);
  });
  it('preserves the exact unconfirmed reservation after a transport failure', async () => {
    const f = fixture();
    f.sendPacket.mockRejectedValueOnce(Error('synthetic transport timeout'));
    const job = await f.plan();
    f.manager.start(job.id);
    await f.done();
    const saved = JSON.parse(readFileSync(f.path, 'utf8')).jobs[0];
    expect(saved).toMatchObject({
      status: 'failed',
      requests: 1,
      checkedWindows: 0,
      inFlight: { start: 471, end: 500 },
    });
    expect(f.sendPacket).toHaveBeenCalledOnce();
  });
  it('does not promote empty protocol windows to recovered coverage', async () => {
    const f = fixture();
    f.sendPacket.mockResolvedValue(
      Buffer.from(encode(GetGroupHistory.respSchema, { body: { groupUin: Number(group.conv) } })),
    );
    const job = await f.plan();
    f.manager.start(job.id);
    await f.done();
    expect(f.manager.list()[0]).toMatchObject({
      status: 'partial',
      observed: 0,
      remainingSeqs: 500,
      pendingSeqs: 0,
      requests: 17,
    });
    expect(await f.history.cachedForExport('group', group.conv)).toHaveLength(0);
  });
  it('does not require the retired aggregate-only capability export', async () => {
    const f = fixture();
    expect('ssoCapabilities' in f.nt).toBe(false);
    expect(await f.fetch()).toMatchObject({ ok: true, networkRequested: true });
    expect(f.sendPacket).toHaveBeenCalledOnce();
  });
});
