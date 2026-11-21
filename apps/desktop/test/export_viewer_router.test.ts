// @vitest-environment node
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { exportViewerRouter } from '../src/main/ipc/routers/export_viewer';
import {
  closeViewerSources,
  registerViewerSource,
  beginViewerRead,
} from '../src/main/export_viewer';
import { withHost, type ExportViewerSource } from '@weq/service';
import { tmpdir } from 'node:os';
import { router } from '../src/main/ipc/trpc';
import { createWebHost } from '../src/main/web/host';
import { pickedBrowserFiles } from '../src/main/browser_files';

const f = vi.hoisted(() => {
  const group = vi.fn(
    async () =>
      ({ targetGroupCode: '777', msgSeq: 12n }) as {
        targetGroupCode: string;
        msgSeq: bigint;
      } | null,
  );
  const contacts = vi.fn(
    async (): Promise<{ targetUid: string; targetUin?: bigint; chatType: string }[]> => [
      { targetUid: '777', chatType: 'KCHATTYPEGROUP' },
    ],
  );
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
it('桌面另存无需账号，取消不落盘且不覆盖同名文件或原件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-viewer-save-'));
  try {
    const dir = join(root, 'archive');
    await mkdir(join(dir, 'media'), { recursive: true });
    const path = `media/${'a'.repeat(64)}`;
    const body = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    await writeFile(join(dir, path), body);
    const item = registerViewerSource({ ...source(), root: dir, path: join(dir, 'space.json') });
    ids.push(item.id);
    f.ctx.services = null;
    const target = join(root, 'save.png');
    const pickSaveTarget = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ path: target, downloadId: null })
      .mockResolvedValueOnce({ path: target, downloadId: null })
      .mockResolvedValueOnce({ path: join(dir, path), downloadId: null });
    const host = { ...createWebHost({ exportDir: root, version: 'test' }), pickSaveTarget };
    const save = () => withHost(host, () => caller.saveMedia({ id: item.id, path }));
    await save();
    expect(await readdir(root)).toEqual(['archive']);
    await save();
    expect(pickSaveTarget).toHaveBeenLastCalledWith({
      defaultName: `${'a'.repeat(64)}.png`,
      extension: 'png',
      locationKey: 'export-viewer-media',
    });
    expect(await readFile(target)).toEqual(body);
    await writeFile(target, '已有文件');
    await expect(save()).rejects.toThrow('目标文件已存在');
    await expect(save()).rejects.toThrow('目标文件已存在');
    expect(await readFile(target, 'utf8')).toBe('已有文件');
    expect(await readFile(join(dir, path))).toEqual(body);
    closeViewerSources([item.id]);
    await expect(save()).rejects.toThrow('未找到');
    expect(pickSaveTarget).toHaveBeenCalledTimes(4);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
it('Remote 从设备上传 JSON 后真实解析分页，不调用电脑文件框或扫描电脑目录', async () => {
  const host = { ...createWebHost({ exportDir: tmpdir(), version: 'test' }), remoteClient: true };
  const remote = router({ exportViewer: exportViewerRouter }).createCaller({ host }).exportViewer;
  await expect(remote.pick({ directory: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(remote.pick({ directory: false })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  const bytes = Buffer.from(
    JSON.stringify({
      meta: { type: 'group', groupId: '777' },
      messages: [
        {
          msgId: '1',
          msgSeq: '1',
          sendTime: 1,
          senderName: '上传者',
          elements: [{ type: 'text', data: { textContent: '设备上传正文' } }],
        },
      ],
    }),
  );
  const upload = await pickedBrowserFiles.start(f.services, bytes.length, 'chat.json');
  try {
    await pickedBrowserFiles.append(f.services, upload.id, 0, bytes);
    const path = pickedBrowserFiles.complete(f.services, upload.id);
    const result = await remote.pick({ directory: false, uploadPath: path });
    const id = result!.sources[0]!.id;
    ids.push(id);
    expect(result?.scanToken).toBeNull();
    expect(result?.sources[0]?.baselineDirectory).toBeUndefined();
    const page = await remote.page({ id, offset: 0 });
    expect(page.messages[0]?.parts[0]?.text).toBe('设备上传正文');
    await expect(
      remote.pick({ directory: false, uploadPath: '/computer/chat.json' }),
    ).rejects.toThrow('本次上传');
  } finally {
    await pickedBrowserFiles.discard(f.services, upload.id);
  }
});
it('精确会话标识关联，打开会话与定位消息复用已有跳转总线', async () => {
  const id = opened();
  expect(await caller.local({ id })).toMatchObject({ kind: 'group', conv: '777', uin: '10001' });
  await caller.jump({ id, ...binding });
  expect(f.push).toHaveBeenLastCalledWith({ kind: 'group', conv: '777', seq: '' });
  await caller.jump({ id, ...binding, msgId: '9001' });
  expect(f.group).toHaveBeenCalledWith('777', 9001n);
  expect(f.push).toHaveBeenLastCalledWith({ kind: 'group', conv: '777', seq: '12', msgId: '9001' });
});
it('相同标识但不同会话类型不关联，账号不可用时仍不触发跳转', async () => {
  const id = opened();
  f.contacts.mockResolvedValue([{ targetUid: '777', chatType: 'KCHATTYPEC2C' }]);
  expect(await caller.local({ id })).toBeNull();
  await expect(caller.jump({ id, ...binding })).rejects.toThrow('不可用');
  expect(f.push).not.toHaveBeenCalled();
});
it('旧私聊只有 QQ 号时映射当前账号的 UID，再按 UID 跳转', async () => {
  const item = registerViewerSource({ ...source(), conversation: { kind: 'c2c', conv: '456' } });
  ids.push(item.id);
  f.contacts.mockResolvedValue([
    { targetUid: 'u_peer', targetUin: 456n, chatType: 'KCHATTYPEC2C' },
  ]);
  expect(await caller.local({ id: item.id })).toMatchObject({ kind: 'c2c', conv: 'u_peer' });
  await caller.jump({ id: item.id, ...binding });
  expect(f.push).toHaveBeenLastCalledWith({ kind: 'c2c', conv: 'u_peer', seq: '' });
  f.contacts.mockResolvedValue([
    { targetUid: 'u_peer', targetUin: 456n, chatType: 'KCHATTYPEC2C' },
    { targetUid: 'u_other', targetUin: 456n, chatType: 'KCHATTYPEC2C' },
  ]);
  expect(await caller.local({ id: item.id })).toBeNull();
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
