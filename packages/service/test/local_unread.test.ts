import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { UnreadInfoSnapshot } from '@weq/db';
import { LocalUnreadStore } from '../src/account/local_unread';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-read-operation-'));
  roots.push(root);
  return join(root, 'unread.json');
}
function snapshot(extra: Partial<UnreadInfoSnapshot> = {}): UnreadInfoSnapshot {
  return { chatType: 2, uid: '70001', peer: '2_70001', latestSeq: '110', msgSeq: 90, ...extra };
}

describe('QQ 小表直接投影', () => {
  it('自发减项补齐时去重，后续入站和已有未读不被当作已读', () => {
    const store = new LocalUnreadStore(undefined, 'u_self');
    const own = snapshot({ latestSenderUid: 'u_self' });
    expect(store.resolve(own)).toMatchObject({ readSeq: '90', unreadCount: 19 });
    expect(store.resolve({ ...own, decreasedSeqs: ['110', '110'] }).unreadCount).toBe(19);
    expect(
      store.resolve(
        snapshot({ latestSeq: '111', latestSenderUid: 'u_peer', decreasedSeqs: ['110'] }),
      ).unreadCount,
    ).toBe(20);
    expect(store.resolve({ ...own, markUnread: true, msgSeq: 109 }).unreadCount).toBe(1);
  });
  it('连续跨端自发和紧接着的回复在减项延迟时保持稳定，阅读后不影响新消息', () => {
    const store = new LocalUnreadStore(undefined, 'u_self');
    expect(store.resolve(snapshot({ msgSeq: 109, latestSenderUid: 'u_self' })).unreadCount).toBe(0);
    expect(
      store.resolve(snapshot({ msgSeq: 109, latestSeq: '111', latestSenderUid: 'u_self' }))
        .unreadCount,
    ).toBe(0);
    expect(
      store.resolve(snapshot({ msgSeq: 109, latestSeq: '112', latestSenderUid: 'u_peer' }))
        .unreadCount,
    ).toBe(1);
    expect(
      store.resolve(
        snapshot({
          msgSeq: 109,
          latestSeq: '112',
          latestSenderUid: 'u_peer',
          decreasedSeqs: ['110', '111'],
        }),
      ).unreadCount,
    ).toBe(1);
    store.markRead(2, '70001', '112');
    expect(
      store.resolve(snapshot({ latestSeq: '113', latestSenderUid: 'u_peer' })).unreadCount,
    ).toBe(1);
  });
  it('缺发送者、缺自身身份、不同会话及设备计数均不误扣', () => {
    const store = new LocalUnreadStore(undefined, 'u_self');
    expect(store.resolve(snapshot({ latestSenderUid: 'u_self' })).unreadCount).toBe(19);
    expect(store.resolve(snapshot({ chatType: 1, peer: '1_70001' })).unreadCount).toBe(20);
    expect(
      store.resolve(snapshot({ uid: 'other', peer: '2_other', latestSenderUid: '' })).unreadCount,
    ).toBe(20);
    expect(new LocalUnreadStore().resolve(snapshot({ latestSenderUid: '' })).unreadCount).toBe(20);
    expect(
      new LocalUnreadStore().resolve(snapshot({ latestSenderUid: 'u_self' })).unreadCount,
    ).toBe(20);
    expect(
      store.resolve(
        snapshot({ chatType: 8, peer: '8_70001', latestSenderUid: 'u_self', localUnreadCount: 3 }),
      ).unreadCount,
    ).toBe(3);
  });
  it('阅读下限取 QQ 服务端、本地和显式操作的最大值，减项去重且只扣区间内项', () => {
    const store = new LocalUnreadStore();
    const row = snapshot({
      localReadSeq: '100',
      decreasedSeqs: ['99', '100', '102', '102', '110', '111'],
    });
    expect(store.resolve(row)).toMatchObject({ readSeq: '100', unreadCount: 8 });
    store.markRead(2, '70001', '105');
    expect(store.resolve(row)).toMatchObject({ readSeq: '105', unreadCount: 4 });
  });
  it('手动未读只维持最小标记，新消息和 QQ 阅读继续改变数量', () => {
    const store = new LocalUnreadStore();
    const row = snapshot({ msgSeq: 110 });
    const change = store.setManualRead(store.resolve(row), true);
    expect(change.applied.readSeq).toBe('110');
    expect(store.resolve(row).unreadCount).toBe(1);
    expect(store.resolve(snapshot({ msgSeq: 110, latestSeq: '113' })).unreadCount).toBe(3);
    expect(
      store.resolve(snapshot({ msgSeq: 113, latestSeq: '113', markUnread: false })).unreadCount,
    ).toBe(0);
  });
  it('数据库确认标记后 QQ 取消标志，即使阅读水位没变也立即清除本地标记', () => {
    const store = new LocalUnreadStore(),
      row = snapshot({ msgSeq: 110 });
    store.setManualRead(store.resolve(row), true);
    expect(store.resolve({ ...row, markUnread: true }).unreadCount).toBe(1);
    expect(store.resolve({ ...row, markUnread: false }).unreadCount).toBe(0);
  });
  it('已读操作被数据库接纳后，不遮住 QQ 后续显式手动未读', () => {
    const store = new LocalUnreadStore();
    store.setManualRead(store.resolve(snapshot()), false);
    expect(store.resolve(snapshot({ msgSeq: 110, markUnread: false })).unreadCount).toBe(0);
    expect(store.resolve(snapshot({ msgSeq: 110, markUnread: true })).unreadCount).toBe(1);
  });
  it('本地阅读覆盖 QQ 覆写，但不会吞掉捕获位置之后的新消息', () => {
    const store = new LocalUnreadStore();
    store.markRead(2, '70001', '110');
    expect(store.resolve(snapshot()).unreadCount).toBe(0);
    expect(store.resolve(snapshot({ latestSeq: '112', decreasedSeqs: ['111'] })).unreadCount).toBe(
      1,
    );
    expect(store.resolve(snapshot({ latestSeq: '115', msgSeq: 113 })).unreadCount).toBe(2);
  });
  it('撤销只恢复操作前位置，期间到达的新消息仍保留', () => {
    const store = new LocalUnreadStore();
    const change = store.setManualRead(store.resolve(snapshot()), false);
    expect(store.resolve(snapshot()).unreadCount).toBe(0);
    expect(store.restoreManualRead(2, '70001', change)).toBe(true);
    expect(store.resolve(snapshot({ latestSeq: '112' })).unreadCount).toBe(22);
  });
  it('后续操作使旧撤销失效，同 UID 不同会话类型不串状态', () => {
    const store = new LocalUnreadStore();
    const change = store.setManualRead(store.resolve(snapshot()), false);
    store.markRead(2, '70001', '111');
    expect(store.restoreManualRead(2, '70001', change)).toBe(false);
    expect(store.resolve(snapshot({ chatType: 1, peer: '1_70001' })).unreadCount).toBe(20);
  });
  it('缺阅读位置不以历史最大序号制造巨量未读，明确标志和提醒可直接显示', () => {
    const store = new LocalUnreadStore();
    expect(store.resolve(snapshot({ msgSeq: undefined, latestSeq: '900000' })).unreadCount).toBe(0);
    expect(store.resolve(snapshot({ msgSeq: undefined, markUnread: true })).unreadCount).toBe(1);
    const hit = {
      kind: 'atMe' as const,
      rawKind: 1000,
      msgSeq: 109,
      senderUid: 'u_peer',
      sendTime: 1,
      text: '',
    };
    expect(store.resolve(snapshot({ msgSeq: undefined, highlights: [hit] }))).toMatchObject({
      unreadCount: 1,
      readSeq: undefined,
    });
    store.markRead(2, '70001', '110');
    expect(store.resolve(snapshot({ highlights: [hit] }))).toMatchObject({
      unreadCount: 0,
      highlights: undefined,
    });
  });
  it.each([8, 134])('设备类型 %s 使用独立计数，不按普通消息序号差计算', (chatType) => {
    const store = new LocalUnreadStore();
    const row = snapshot({
      chatType,
      peer: `${chatType}_70001`,
      storedUnreadCount: chatType === 134 ? 3 : undefined,
      localUnreadCount: chatType === 8 ? 2 : undefined,
    });
    expect(store.resolve(row).unreadCount).toBe(chatType === 134 ? 3 : 2);
    store.markRead(chatType, '70001', '110');
    expect(store.resolve(row).unreadCount).toBe(0);
  });
  it('损坏快照不投影为零', () => {
    expect(
      new LocalUnreadStore().resolve(snapshot({ readError: true })).unreadCount,
    ).toBeUndefined();
  });
});

describe('只迁移显式操作', () => {
  it('旧观察位置与 pending 不迁移，实际本地阅读和手动标记仍生效', async () => {
    const path = fixture();
    writeFileSync(
      path,
      JSON.stringify({
        '2_70001': { sourceVersion: 1, latestSeq: '110', readSeq: '110', pending: ['109'] },
        '1_u_read': {
          sourceVersion: 1,
          latestSeq: '110',
          readSeq: '105',
          localReadSeq: '105',
          pending: [],
        },
      }),
    );
    const store = new LocalUnreadStore(path);
    expect(store.resolve(snapshot()).unreadCount).toBe(20);
    expect(
      store.resolve(snapshot({ chatType: 1, uid: 'u_read', peer: '1_u_read' })).unreadCount,
    ).toBe(5);
    store.markRead(2, '70001', '108');
    await store.flush();
    const saved = readFileSync(path, 'utf8');
    expect(saved).not.toContain('pending');
    expect(saved).not.toContain('baselineSeq');
    expect(new LocalUnreadStore(path).resolve(snapshot()).unreadCount).toBe(2);
  });
  it('数据库已经超过旧显式阅读时移除覆盖，不把同水位 WeQ 自己写库误作 QQ 确认', async () => {
    const path = fixture(),
      store = new LocalUnreadStore(path);
    store.markRead(2, '70001', '100');
    store.resolve(snapshot({ msgSeq: 100 }));
    expect(store.resolve(snapshot({ msgSeq: 90 })).unreadCount).toBe(10);
    store.resolve(snapshot({ msgSeq: 105 }));
    await store.flush();
    expect(JSON.parse(readFileSync(path, 'utf8'))['2_70001'].readSeq).toBeUndefined();
  });
  it('观察快照不创建状态文件，每个会话仅保存显式操作', async () => {
    const store = new LocalUnreadStore();
    for (let i = 0; i < 1300; i++) store.resolve(snapshot({ uid: String(i), peer: `2_${i}` }));
    await store.flush();
    store.markRead(2, '70001', '110');
    expect(store.resolve(snapshot()).unreadCount).toBe(0);
  });
});
