import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CallRecordingStore, formatStamp } from '../src/main/call_recording_store';

const dirs: string[] = [];
async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'weq-call-store-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** 建一条录音（连文件一起，`resolve` 会检查文件存在）。 */
async function seed(
  store: CallRecordingStore,
  entry: {
    conv: string;
    endedAt: number;
    kind?: 'c2c' | 'group';
    durationSec?: number;
  },
) {
  const created = await store.create({
    kind: entry.kind ?? 'c2c',
    conv: entry.conv,
    peerUin: '10001',
    peerName: '好友',
    startedAt: entry.endedAt - 60_000,
    endedAt: entry.endedAt,
    durationSec: entry.durationSec ?? 60,
    mode: 'mixed',
    systemAudio: false,
  });
  await writeFile(join(store.root, created.fileName), 'wav');
  return created;
}

describe('CallRecordingStore', () => {
  it('建索引、写文件、按 id 解析路径', async () => {
    const store = new CallRecordingStore(await tempRoot());
    const entry = await seed(store, { conv: 'u_peer', endedAt: 1_700_000_000_000 });
    expect(entry.fileName).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_10001\.wav$/);
    expect(await store.resolve(entry.id)).toBe(join(store.root, entry.fileName));
  });

  it('索引文件被删 / 损坏时当作空表，不抛错', async () => {
    const root = await tempRoot();
    const store = new CallRecordingStore(root);
    await store.create({
      kind: 'c2c',
      conv: 'u_peer',
      peerUin: '10001',
      peerName: '',
      startedAt: 1,
      endedAt: 2,
      durationSec: 1,
      mode: 'mixed',
      systemAudio: false,
    });
    await writeFile(join(root, 'index.json'), '{ 坏掉的 json');
    const fresh = new CallRecordingStore(root);
    expect(await fresh.list()).toEqual([]);
  });

  it('msgId 精确命中优先于时间窗', async () => {
    const store = new CallRecordingStore(await tempRoot());
    const claimed = await seed(store, { conv: 'u_peer', endedAt: 1_700_000_000_000 });
    const other = await seed(store, { conv: 'u_peer', endedAt: 1_700_000_030_000 });
    await store.match({ kind: 'c2c', conv: 'u_peer', sendTimeMs: 1_700_000_000_000, msgId: 'm1' });

    // 即使时间上 `other` 更近，认领过的那条也优先。
    const hit = await store.match({
      kind: 'c2c',
      conv: 'u_peer',
      sendTimeMs: 1_700_000_030_000,
      msgId: 'm1',
    });
    expect(hit?.id).toBe(claimed.id);
    expect(other.id).not.toBe(claimed.id);
  });

  it('时间窗兜底：同会话 90 秒内最近的一条，并回写 msgId', async () => {
    const store = new CallRecordingStore(await tempRoot());
    const far = await seed(store, { conv: 'u_peer', endedAt: 1_700_000_000_000 });
    const near = await seed(store, { conv: 'u_peer', endedAt: 1_700_000_060_000 });

    const hit = await store.match({
      kind: 'c2c',
      conv: 'u_peer',
      sendTimeMs: 1_700_000_062_000,
      msgId: 'm2',
    });
    expect(hit?.id).toBe(near.id);
    expect(hit?.id).not.toBe(far.id);

    // 认领已落盘：新实例也能读到。
    const reloaded = new CallRecordingStore(store.root);
    expect((await reloaded.list()).find((item) => item.msgId === 'm2')?.id).toBe(near.id);
  });

  it('时间窗之外不匹配', async () => {
    const store = new CallRecordingStore(await tempRoot());
    await seed(store, { conv: 'u_peer', endedAt: 1_700_000_000_000 });
    const hit = await store.match({
      kind: 'c2c',
      conv: 'u_peer',
      sendTimeMs: 1_700_000_000_000 + 91_000,
    });
    expect(hit).toBeNull();
  });

  it('跨会话不串', async () => {
    const store = new CallRecordingStore(await tempRoot());
    await seed(store, { conv: 'u_alice', endedAt: 1_700_000_000_000 });
    const hit = await store.match({
      kind: 'c2c',
      conv: 'u_bob',
      sendTimeMs: 1_700_000_000_000,
    });
    expect(hit).toBeNull();
  });

  it('群聊与私聊不互相认领', async () => {
    const store = new CallRecordingStore(await tempRoot());
    await seed(store, { conv: '123456', endedAt: 1_700_000_000_000, kind: 'group' });
    expect(
      await store.match({ kind: 'c2c', conv: '123456', sendTimeMs: 1_700_000_000_000 }),
    ).toBeNull();
    expect(
      await store.match({ kind: 'group', conv: '123456', sendTimeMs: 1_700_000_000_000 }),
    ).not.toBeNull();
  });

  it('文件被删掉时 resolve 返回 null（界面显示录音已丢失）', async () => {
    const store = new CallRecordingStore(await tempRoot());
    const entry = await seed(store, { conv: 'u_peer', endedAt: 1_700_000_000_000 });
    await rm(join(store.root, entry.fileName));
    expect(await store.resolve(entry.id)).toBeNull();
  });

  it('索引里的 fileName 逃出录音根时拒绝解析', async () => {
    const root = await tempRoot();
    const store = new CallRecordingStore(root);
    const entry = await seed(store, { conv: 'u_peer', endedAt: 1_700_000_000_000 });
    // 手工把索引改成一个越界路径（模拟索引被外部篡改）。
    await writeFile(
      join(root, 'index.json'),
      JSON.stringify([{ ...entry, fileName: '../../../etc/passwd' }]),
      'utf8',
    );
    const tampered = new CallRecordingStore(root);
    expect(await tampered.resolve(entry.id)).toBeNull();
  });

  it('update 补上时长与结束时刻', async () => {
    const store = new CallRecordingStore(await tempRoot());
    const entry = await seed(store, { conv: 'u_peer', endedAt: 1_700_000_000_000, durationSec: 0 });
    await store.update({ ...entry, endedAt: 1_700_000_123_000, durationSec: 123 });
    const reloaded = new CallRecordingStore(store.root);
    const item = (await reloaded.list()).find((row) => row.id === entry.id);
    expect(item).toMatchObject({ durationSec: 123, endedAt: 1_700_000_123_000 });
  });

  it('同一秒建两条不会撞名', async () => {
    const store = new CallRecordingStore(await tempRoot());
    const a = await seed(store, { conv: 'u_peer', endedAt: 1_700_000_000_000 });
    const b = await seed(store, { conv: 'u_peer', endedAt: 1_700_000_000_000 });
    expect(a.fileName).not.toBe(b.fileName);
  });

  it('formatStamp 用本地时间且不含冒号', () => {
    const stamp = formatStamp(new Date(2026, 9, 25, 21, 3, 11).getTime());
    expect(stamp).toBe('2026-10-25_21-03-11');
  });
});
