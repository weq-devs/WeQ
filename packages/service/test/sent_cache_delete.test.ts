import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { DeletedMsgStore } from '../src/account/deleted_msgs';
import { MsgService } from '../src/account/msg';
import type { GapFetchedMessage } from '../src/account/gap_history';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const message: GapFetchedMessage = {
  kind: 'group',
  conv: '777',
  msgId: '1234',
  msgSeq: '2',
  senderUid: 'u_self',
  senderUin: '10001',
  sendTime: '1792544400',
  elements: [],
  sourceFormat: 'protocol',
  localSent: true,
};
it('自己的缓存消息可删除和恢复，标记持久化并按会话隔离，不读取或改写 QQ 原库', () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-sent-delete-'));
  roots.push(root);
  const path = join(root, 'deleted.json');
  const session = new Proxy(
    {},
    {
      get() {
        throw new Error('缓存删除不能读取 QQ 原库');
      },
    },
  ) as never;
  const service = new MsgService(session, new DeletedMsgStore(path));
  const id = 'roaming:protocol:2:1234';
  expect(service.deleteCachedSentMessage(message)).toBe(true);
  expect(service.deleteCachedSentMessage({ ...message, conv: '888' })).toBe(true);
  const reopened = new MsgService(session, new DeletedMsgStore(path));
  expect(reopened.getDeletedMsgIds('group', '777')).toEqual([id]);
  expect(reopened.getDeletedMsgIds('group', '888')).toEqual([id]);
  expect(reopened.restoreCachedSentMessage(id, 'c2c', '777')).toBe(false);
  expect(reopened.restoreCachedSentMessage(id, 'group', '777')).toBe(true);
  expect(reopened.getDeletedMsgIds('group', '777')).toEqual([]);
  expect(reopened.getDeletedMsgIds('group', '888')).toEqual([id]);
  expect(
    new MsgService(session, new DeletedMsgStore(path)).getDeletedMsgIds('group', '777'),
  ).toEqual([]);
});
it('普通漫游、未核实私聊序号及非协议来源不能走自发缓存删除', () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-sent-delete-'));
  roots.push(root);
  const service = new MsgService({} as never, new DeletedMsgStore(join(root, 'deleted.json')));
  for (const row of [
    { ...message, localSent: false },
    { ...message, kind: 'c2c' as const, ntSeqVerified: false },
    { ...message, sourceFormat: 'native' as const },
    { ...message, msgSeq: '0' },
  ])
    expect(service.deleteCachedSentMessage(row)).toBe(false);
  expect(service.getDeletedMsgIds('group', '777')).toEqual([]);
});
