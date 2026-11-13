import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GetGroupJoinInfo, type GroupProfileExtras } from '@weq/protocol';
import { afterEach, expect, it, vi } from 'vitest';
import { GroupProfileReader } from '../src/account/group_profile';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const profile: GroupProfileExtras = {
  grade: 0,
  activeMemberCount: 0,
  freezeState: 0,
  freezeReason: 0,
  portraitSequence: null,
  portrait: null,
};
const reply = (extensions = profile) => ({
  groupId: 123,
  name: '云端群名',
  maxMemberCount: null,
  memberCount: null,
  categoryId: null,
  categoryName: null,
  option: null,
  question: null,
  questionState: 'unavailable' as const,
  extensions,
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'weq-group-profile-'));
  roots.push(root);
  let pid = 5;
  const reader = new GroupProfileReader({
    nt: { sendOidbPacket: vi.fn() },
    resolvePid: () => {
      if (pid < 0) throw new Error('QQ 离线');
      return pid;
    },
  });
  reader.setCache(root);
  return {
    root,
    reader,
    setPid: (value: number) => {
      pid = value;
    },
  };
}
it('缓存读取不发包，首次按需读取及 TTL 复用，强制刷新可重试', async () => {
  const { reader } = await setup();
  const invoke = vi.spyOn(GetGroupJoinInfo, 'invoke').mockResolvedValue(reply());
  expect((await reader.read(123)).source).toBe('empty');
  expect(invoke).not.toHaveBeenCalled();
  expect(await reader.read(123, true)).toMatchObject({ groupId: 123, source: 'online', profile });
  expect((await reader.read(123, true)).source).toBe('cache');
  expect(invoke).toHaveBeenCalledTimes(1);
  await reader.read(123, true, true);
  expect(invoke).toHaveBeenCalledTimes(2);
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60_000);
  await reader.read(123, true);
  expect(invoke).toHaveBeenCalledTimes(3);
});
it('同群并发合并，返回对象不共享可变缓存', async () => {
  const { reader } = await setup();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const invoke = vi.spyOn(GetGroupJoinInfo, 'invoke').mockImplementation(async () => {
    await wait;
    return reply();
  });
  const a = reader.read(123, true),
    b = reader.read(123, true, true);
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  release();
  const first = await a;
  const second = await b;
  first.profile!.grade = 99;
  expect(second.profile!.grade).toBe(0);
  expect((await reader.read(123)).profile?.grade).toBe(0);
});
it('失败保留旧缓存，重开离线可读，按账号目录隔离', async () => {
  const { root, reader } = await setup();
  const invoke = vi.spyOn(GetGroupJoinInfo, 'invoke').mockResolvedValue(reply());
  await reader.read(123, true);
  invoke.mockRejectedValue(new Error('服务端错误'));
  expect(await reader.read(123, true, true)).toMatchObject({
    source: 'cache',
    profile,
    error: '群扩展资料读取失败',
  });
  const offline = new GroupProfileReader();
  offline.setCache(root);
  expect(await offline.read(123)).toMatchObject({ source: 'cache', profile });
  expect((await offline.read(124)).source).toBe('empty');
  expect((await new GroupProfileReader().read(123)).profile).toBeNull();
});
it('有效的新回包缺字段会变为未知，不保留旧值冒充当前返回，也不保存云端名称', async () => {
  const { root, reader } = await setup();
  const invoke = vi.spyOn(GetGroupJoinInfo, 'invoke').mockResolvedValue(reply());
  await reader.read(123, true);
  invoke.mockResolvedValue(reply({ ...profile, grade: null, activeMemberCount: null }));
  expect((await reader.read(123, true, true)).profile).toMatchObject({
    grade: null,
    activeMemberCount: null,
  });
  expect(await readFile(join(root, '123.json'), 'utf8')).not.toContain('云端群名');
});
it('进程切换或关闭后不写入迟到响应', async () => {
  for (const close of [false, true]) {
    const { root, reader, setPid } = await setup();
    vi.spyOn(GetGroupJoinInfo, 'invoke').mockImplementation(async () => {
      if (close) reader.dispose();
      else setPid(6);
      return reply();
    });
    await expect(reader.read(123, true)).rejects.toThrow(close ? '关闭' : '切换');
    await expect(readFile(join(root, '123.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  }
});
it('错群或非法回包不保存；损坏缓存与其他群缓存不作有效快照', async () => {
  const { root, reader } = await setup();
  await writeFile(
    join(root, '123.json'),
    JSON.stringify({ version: 1, groupId: 124, updatedAt: Date.now(), profile }),
  );
  expect((await reader.read(123)).profile).toBeNull();
  vi.spyOn(GetGroupJoinInfo, 'invoke').mockResolvedValue({ ...reply(), groupId: 124 });
  expect((await reader.read(123, true)).error).toBe('群扩展资料读取失败');
  await expect(reader.read(0)).rejects.toThrow('格式');
});

it('缓存落盘失败仍交付在线资料，并保留内存结果供重试', async () => {
  const { root, reader } = await setup();
  const blocked = join(root, 'blocked');
  await writeFile(blocked, 'synthetic');
  reader.setCache(blocked);
  vi.spyOn(GetGroupJoinInfo, 'invoke').mockResolvedValue(reply());
  expect(await reader.read(123, true)).toMatchObject({
    source: 'online',
    profile,
    error: '资料已读取，缓存保存失败',
  });
  expect((await reader.read(123)).profile).toEqual(profile);
});
it('本人时间随扩展快照保存，离线重开仍能读取', async () => {
  const { root, reader } = await setup();
  vi.spyOn(GetGroupJoinInfo, 'invoke').mockResolvedValue(
    reply({ ...profile, joinedAt: 1704038407 }),
  );
  await reader.read(123, true);
  const reopened = new GroupProfileReader();
  reopened.setCache(root);
  expect((await reopened.read(123)).profile?.joinedAt).toBe(1704038407);
});

it('请求期间 QQ 离线时保留旧快照，不把迟到的新值存入缓存', async () => {
  const { reader, setPid } = await setup();
  const invoke = vi.spyOn(GetGroupJoinInfo, 'invoke').mockResolvedValue(reply());
  await reader.read(123, true);
  invoke.mockImplementationOnce(async () => {
    setPid(-1);
    return reply({ ...profile, grade: 9 });
  });
  expect(await reader.read(123, true, true)).toMatchObject({
    source: 'cache',
    profile,
    error: '群扩展资料读取失败',
  });
  expect((await reader.read(123)).profile).toEqual(profile);
});
