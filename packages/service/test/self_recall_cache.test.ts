import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountSession } from '@weq/account';
import { closeAllFixtureDbs, createSqliteStub } from '@weq/testkit';
import { GapHistoryService, type GapFetchedMessage } from '../src/account/gap_history';
import { RoamMsgCacheDb } from '../src/account/roam_msg_cache';
import { mergeRoamingTimeline } from '../src/common/roaming_timeline';
import { AntiRecallService } from '../src/account/anti_recall';
import type { Platform } from '@weq/platform';

const roots: string[] = [];
afterEach(() => {
  closeAllFixtureDbs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'weq-self-recall-'));
  roots.push(root);
  const nt = createSqliteStub();
  const path = join(root, 'cache.db');
  const history = new GapHistoryService(
    nt,
    { selfUid: 'u_self' } as AccountSession,
    () => 42,
    path,
  );
  const sent: GapFetchedMessage = {
    kind: 'c2c',
    conv: 'u_peer',
    msgId: '1234',
    msgRandom: '1234',
    msgSeq: '42',
    clientSeq: '3',
    sendTime: '1700000000',
    senderUid: 'u_self',
    senderUin: '10001',
    sourceFormat: 'protocol',
    localSent: true,
    ntSeqVerified: true,
    elements: [{ type: 'text', data: { textContent: '原文' } }],
  };
  const params = {
    kind: 'c2c' as const,
    conv: sent.conv,
    sequence: 42,
    random: 1234,
    clientSequence: 3,
    timestamp: 1700000000,
  };
  return { history, cache: new RoamMsgCacheDb(nt, path), sent, params };
}

describe('WeQ 自撤缓存保护', () => {
  it('撤回成功后保住发送原文，空漫游结果与 QQ 灰条不能覆盖它', async () => {
    const { history, cache, sent, params } = setup();
    await cache.store([sent]);
    await history.withSelfRecallProtection(params, async () => {
      await cache.store([{ ...sent, msgId: '5678', localSent: undefined, elements: [] }]);
    });
    const cached = await history.cachedTimeline('c2c', sent.conv, 42, 42, 50, false);
    expect(cached).toHaveLength(1);
    expect(cached[0]).toMatchObject({
      elements: sent.elements,
      recall: { revokeUid: 'u_self', sameSender: true, recallTs: expect.any(Number) },
    });
    const gray = {
      ...sent,
      localSent: undefined,
      msgId: '90000000001',
      elements: [{ type: 'grayTipRevoke' as const, data: {} }],
    };
    const unrelated = { ...gray, msgId: '90000000002', senderUid: '' };
    const merged = mergeRoamingTimeline('c2c', [gray, unrelated], cached);
    expect(merged.map((row) => row.msgId)).toEqual(['1234', '90000000002']);
    expect(await history.cachedRecalls('c2c', sent.conv)).toHaveLength(1);
    // 同一个缓存主键被服务端回填时，也不能冲掉已保存的原文。
    await cache.store([{ ...sent, localSent: undefined, elements: [] }]);
    expect((await history.cachedRecalls('c2c', sent.conv))[0]?.elements).toEqual(sent.elements);
  });

  it('撤回失败不标记成功，也不吞掉错误', async () => {
    const { history, cache, sent, params } = setup();
    await cache.store([sent]);
    await expect(
      history.withSelfRecallProtection(params, async () => {
        throw Error('服务端拒绝');
      }),
    ).rejects.toThrow('服务端拒绝');
    expect(await history.cachedRecalls()).toEqual([]);
  });

  it.each(['random', 'clientSequence', 'timestamp'] as const)(
    '定位的 %s 不匹配时不误保其他消息',
    async (field) => {
      const { history, cache, sent, params } = setup();
      await cache.store([sent]);
      const send = vi.fn(async () => {});
      await history.withSelfRecallProtection({ ...params, [field]: params[field] + 1 }, send);
      expect(send).toHaveBeenCalledOnce();
      expect(await history.cachedRecalls()).toEqual([]);
    },
  );

  it('不把同序号的其他发送者记成自己撤回', async () => {
    const { history, cache, sent, params } = setup();
    await cache.store([{ ...sent, senderUid: 'u_other' }]);
    await history.withSelfRecallProtection(params, async () => {});
    expect(await history.cachedRecalls()).toEqual([]);
  });

  it('群聊沿用同一保护，不要求私聊的客户端序号与时间戳', async () => {
    const { history, cache, sent, params } = setup();
    const group = { ...sent, kind: 'group' as const, conv: '777', clientSeq: undefined };
    await cache.store([group]);
    await history.withSelfRecallProtection(
      {
        ...params,
        kind: 'group',
        conv: group.conv,
        clientSequence: undefined,
        timestamp: undefined,
      },
      async () => {},
    );
    expect((await history.cachedRecalls('group', group.conv))[0]?.elements).toEqual(sent.elements);
    cache.close();
    expect(await history.cachedRecalls('group', group.conv)).toHaveLength(1);
  });

  it('未验证的私聊缓存不能挤掉原库消息', () => {
    const local = { msgId: '9', msgSeq: '42', msgRandom: '1234', senderUid: 'u_self' };
    const unverified = {
      ...local,
      msgId: '1234',
      localSent: true,
      recall: { revokeUid: 'u_self', sameSender: true, recallTs: 1 },
    };
    expect(mergeRoamingTimeline('c2c', [local], [unverified])).toEqual([local]);
  });

  it('缓存保护遵守总开关与按会话名单', () => {
    const root = mkdtempSync(join(tmpdir(), 'weq-recall-config-'));
    roots.push(root);
    const path = join(root, 'config.json');
    const open = (enabled: boolean, mode = 'selected') => {
      writeFileSync(
        path,
        JSON.stringify({ enabled, mode, targets: [{ kind: 'c2c', id: 'u_peer' }] }),
      );
      return new AntiRecallService({} as AccountSession, {} as Platform, path);
    };
    expect(open(false).protects('c2c', 'u_peer')).toBe(false);
    const service = open(true);
    expect(service.protects('c2c', 'u_peer')).toBe(true);
    expect(service.protects('c2c', 'u_other')).toBe(false);
    expect(service.protects('group', 'u_peer')).toBe(false);
    expect(open(true, 'all').protects('group', '777')).toBe(true);
    expect(open(false, 'all').protects('c2c', 'u_peer')).toBe(false);
  });
});
