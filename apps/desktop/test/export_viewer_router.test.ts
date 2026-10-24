import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { exportViewerRouter } from '../src/main/ipc/routers/export_viewer';
import {
  closeViewerSources,
  registerViewerSource,
  beginViewerRead,
} from '../src/main/export_viewer';
import type { ExportViewerSource } from '@weq/service';

const f = vi.hoisted(() => {
  const group = vi.fn(
    async () =>
      ({ targetGroupCode: '777', msgSeq: 12n }) as {
        targetGroupCode: string;
        msgSeq: bigint;
      } | null,
  );
  const contacts = vi.fn(async () => [{ targetUid: '777', chatType: 'KCHATTYPEGROUP' }]);
  const services = {
    recentContacts: { getRecentContact: contacts },
    accountConfig: { getRecord: () => ({ configId: 'source-a' }) },
    msgs: { getGroupMessageById: group, getC2cMessageById: vi.fn() },
  };
  return {
    services,
    ctx: { services: services as typeof services | null, account: { context: { uin: '10001' } } },
    group,
    contacts,
    push: vi.fn(),
  };
});
vi.mock('../src/main/context/app_context', () => ({ getAppContext: () => f.ctx }));
vi.mock('../src/main/group_keyword_bus', () => ({ pushConversationJump: f.push }));
const ids: string[] = [];
const source = (): ExportViewerSource => ({
  path: '/synthetic/chat.jsonl',
  root: '/synthetic',
  name: '合成记录',
  format: 'jsonl',
  bytes: 0,
  updatedAt: 0,
  fileMtimeMs: 0,
  messageCount: 1,
  conversation: { kind: 'group', conv: '777' },
});
function opened() {
  const item = registerViewerSource(source());
  ids.push(item.id);
  return item.id;
}
beforeEach(() => {
  f.ctx.services = f.services;
  f.ctx.account.context.uin = '10001';
  f.push.mockClear();
  f.contacts.mockReset().mockResolvedValue([{ targetUid: '777', chatType: 'KCHATTYPEGROUP' }]);
  f.group.mockReset().mockResolvedValue({ targetGroupCode: '777', msgSeq: 12n });
});
afterEach(() => closeViewerSources(ids.splice(0)));
const caller = exportViewerRouter.createCaller({});
const binding = { expectedUin: '10001', expectedConfigId: 'source-a' };
it('精确会话标识关联，打开会话与定位消息复用已有跳转总线', async () => {
  const id = opened();
  expect(await caller.local({ id })).toMatchObject({ kind: 'group', conv: '777', uin: '10001' });
  await caller.jump({ id, ...binding });
  expect(f.push).toHaveBeenLastCalledWith({ kind: 'group', conv: '777', seq: '' });
  await caller.jump({ id, ...binding, msgId: '9001' });
  expect(f.group).toHaveBeenCalledWith('777', 9001n);
  expect(f.push).toHaveBeenLastCalledWith({ kind: 'group', conv: '777', seq: '12' });
});
it('相同标识但不同会话类型不关联，账号不可用时仍不触发跳转', async () => {
  const id = opened();
  f.contacts.mockResolvedValue([{ targetUid: '777', chatType: 'KCHATTYPEC2C' }]);
  expect(await caller.local({ id })).toBeNull();
  await expect(caller.jump({ id, ...binding })).rejects.toThrow('不可用');
  expect(f.push).not.toHaveBeenCalled();
});
it('本机缺少消息、消息属于其他会话或无有效序号时不跳错位置', async () => {
  const id = opened();
  for (const value of [
    null,
    { targetGroupCode: '888', msgSeq: 12n },
    { targetGroupCode: '777', msgSeq: 0n },
  ]) {
    f.group.mockResolvedValueOnce(value);
    await expect(caller.jump({ id, ...binding, msgId: '9001' })).rejects.toThrow();
  }
  expect(f.push).not.toHaveBeenCalled();
});
it('等待会话目录期间切换账号会使关联失效，不用新账号完成旧请求', async () => {
  const id = opened();
  f.contacts.mockImplementationOnce(async () => {
    f.ctx.services = { ...f.services };
    return [{ targetUid: '777', chatType: 'KCHATTYPEGROUP' }];
  });
  await expect(caller.local({ id })).rejects.toThrow('已切换');
  expect(f.push).not.toHaveBeenCalled();
});
it('等待原消息期间切换账号会中止跳转，过期授权身份也被拒绝', async () => {
  const id = opened();
  await expect(caller.jump({ id, ...binding, expectedConfigId: 'other' })).rejects.toThrow();
  f.group.mockImplementationOnce(async () => {
    f.ctx.services = { ...f.services };
    return { targetGroupCode: '777', msgSeq: 12n };
  });
  await expect(caller.jump({ id, ...binding, msgId: '9001' })).rejects.toThrow('已切换');
  expect(f.push).not.toHaveBeenCalled();
});
it('关闭导出后撤销查看与媒体访问能力', async () => {
  const id = opened();
  await caller.close({ ids: [id] });
  await expect(caller.local({ id })).rejects.toThrow('已关闭');
});
it('同一来源的新查询取消旧扫描，关闭会取消当前扫描', () => {
  const id = opened();
  const first = beginViewerRead(id),
    second = beginViewerRead(id);
  expect(first.aborted).toBe(true);
  expect(second.aborted).toBe(false);
  closeViewerSources([id]);
  expect(second.aborted).toBe(true);
});
