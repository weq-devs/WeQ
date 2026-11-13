// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createQQActionsRouter, type QQActionServices } from '../src/main/ipc/routers/qq_actions';
import { createProfileExtrasRouter } from '../src/main/ipc/routers/profile_extras';
import type { ProfileExtrasService } from '@weq/service';

const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'fixture' };
const signature = { ...binding, uin: '10002', id: '66656564', createdAt: 123 };
function fixture() {
  let pid = 5;
  const methods = {
    signatureLike: vi.fn(async () => ({ state: 'accepted' as const })),
    signatureComment: vi.fn(async () => ({
      state: 'accepted' as const,
      commentId: '9007199254740993',
    })),
    deleteSignatureComment: vi.fn(async () => ({ state: 'accepted' as const })),
  };
  const services = {
    accountWrite: methods,
    accountConfig: { getRecord: () => ({ qqPid: pid }) },
  } as unknown as QQActionServices;
  const routes = createQQActionsRouter((input) => {
    if (
      input.expectedAccountUin !== binding.expectedAccountUin ||
      input.expectedAccountConfigId !== binding.expectedAccountConfigId
    )
      throw new Error('账号不匹配');
    return services;
  });
  return {
    caller: routes.createCaller({}),
    methods,
    switchPid: () => {
      pid = 6;
    },
  };
}
it('签名操作路由固定账号，保留零值与大整数评论 ID', async () => {
  const { caller, methods } = fixture();
  expect(await caller.signatureLike({ ...signature, liked: false })).toEqual({ state: 'accepted' });
  expect(methods.signatureLike).toHaveBeenLastCalledWith(
    '10002',
    expect.objectContaining({ id: signature.id }),
    false,
  );
  expect(
    await caller.signatureComment({
      ...binding,
      uin: '10002',
      id: signature.id,
      text: '内容',
      replyId: '0',
    }),
  ).toMatchObject({ commentId: '9007199254740993' });
  await caller.deleteSignatureComment({ ...signature, commentId: '9007199254740993' });
  expect(methods.deleteSignatureComment).toHaveBeenLastCalledWith(
    '10002',
    expect.objectContaining({ id: signature.id }),
    '9007199254740993',
  );
  await expect(
    caller.signatureLike({ ...signature, expectedAccountConfigId: 'other', liked: true }),
  ).rejects.toThrow('账号');
});
it('重复提交不重发，异步期间进程改变不返回旧结果', async () => {
  const { caller, methods, switchPid } = fixture();
  let release!: () => void;
  methods.signatureLike.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { state: 'accepted' };
  });
  const first = caller.signatureLike({ ...signature, liked: true });
  await vi.waitFor(() => expect(methods.signatureLike).toHaveBeenCalledTimes(1));
  await expect(caller.signatureLike({ ...signature, liked: true })).rejects.toThrow('等待');
  switchPid();
  release();
  await expect(first).rejects.toThrow('运行时');
});
it('互动读取目标切换后丢弃旧结果，评论游标原样传递', async () => {
  const page = {
    targetUin: '10002',
    items: [],
    hasMore: false,
    nextCursor: null,
    paginationError: null,
  };
  const read = vi.fn(async () => page);
  const service = { anonymousComments: read } as unknown as ProfileExtrasService;
  let active = { profileExtras: service };
  const caller = createProfileExtrasRouter(() => active).createCaller({});
  await caller.anonymousComments({ ...binding, uin: '10002', questionId: 'q1', cursor: 'next' });
  expect(read).toHaveBeenLastCalledWith('10002', 'q1', 'next');
  read.mockImplementationOnce(async () => {
    active = { profileExtras: service };
    return page;
  });
  await expect(
    caller.anonymousComments({ ...binding, uin: '10002', questionId: 'q1' }),
  ).rejects.toThrow('变化');
});
