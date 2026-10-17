import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSqliteStub, closeAllFixtureDbs } from '@weq/testkit';
import type { AccountSession } from '@weq/account';
import { GapHistoryService, type GapFetchedMessage } from '../src/account/gap_history';
import { withRoamingRequest } from '../src/common/roaming_request_queue';

const roots: string[] = [];
afterEach(() => {
  closeAllFixtureDbs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-roaming-transport-'));
  roots.push(root);
  const nt = createSqliteStub();
  const send = vi.fn(async () => {
    throw new Error('No real native transport in this test');
  });
  nt.sendPacket = send;
  const state = { online: true };
  const pid = vi.fn(() => {
    if (!state.online) throw Error('offline fixture');
    return 123;
  });
  const history = new GapHistoryService(nt, {} as AccountSession, pid, join(root, 'cache.db'));
  const rows: GapFetchedMessage[] = [2, 3, 4].map((seq) => ({
    kind: 'group',
    conv: '12345',
    msgId: String(seq),
    msgSeq: String(seq),
    senderUid: 'u_fixture',
    senderUin: '10000',
    sendTime: '1700000000',
    elements: [],
  }));
  return { history, send, pid, state, rows };
}
async function holdQueue() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = vi.fn();
  const done = withRoamingRequest(async () => {
    entered();
    await wait;
  });
  await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
  return { release, done };
}

describe('history admission and cache revalidation', () => {
  it('rechecks online identity after waiting, without sending a packet for an expired admission', async () => {
    const f = fixture();
    const gate = await holdQueue();
    const read = f.history.fetch('group', '12345', 2, 4);
    try {
      await vi.waitFor(() => expect(f.pid).toHaveBeenCalledOnce());
      f.state.online = false;
    } finally {
      gate.release();
      await gate.done;
    }
    expect(await read).toMatchObject({ ok: false, reason: 'offline', networkRequested: false });
    expect(f.send).not.toHaveBeenCalled();
  });
  it('coalesces a queued window filled by another caller without claiming a network request', async () => {
    const f = fixture();
    const gate = await holdQueue();
    const read = f.history.fetch('group', '12345', 2, 4);
    try {
      await vi.waitFor(() => expect(f.pid).toHaveBeenCalledOnce());
      await f.history.retainForBatch(f.rows);
    } finally {
      gate.release();
      await gate.done;
    }
    const result = await read;
    expect(result).toMatchObject({ ok: true, fetched: 0, networkRequested: false });
    if (result.ok) expect(result.messages).toHaveLength(3);
    expect(f.send).not.toHaveBeenCalled();
  });
  it('reads complete cached windows while offline without even reserving a live identity', async () => {
    const f = fixture();
    await f.history.retainForBatch(f.rows);
    f.state.online = false;
    expect(await f.history.fetch('group', '12345', 2, 4)).toMatchObject({
      ok: true,
      networkRequested: false,
    });
    expect(f.pid).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(await f.history.fetch('group', '12345', 2, 5, { strictIdentity: true })).toMatchObject({
      ok: false,
      reason: 'offline',
      networkRequested: false,
    });
    expect(f.send).not.toHaveBeenCalled();
  });
});
