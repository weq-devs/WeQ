// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { scheduleDatabase } from '@weq/db';
import { accountRouter } from '../src/main/ipc/routers/account';

const fixture = vi.hoisted(() => ({ profile: vi.fn(), latest: vi.fn(), media: vi.fn() }));
vi.mock('../src/main/context/app_context', () => {
  const services = {
    accountConfig: { getRecord: () => ({ configId: 'fixture' }) },
    profile: { listProfiles: (...args: unknown[]) => fixture.profile(...args) },
    msgs: {
      getGroupLatest: (...args: unknown[]) => fixture.latest(...args),
      getReplyMedia: (...args: unknown[]) => fixture.media(...args),
    },
    gapHistory: { cachedTimeline: async () => [] },
  };
  return { getAppContext: () => ({ account: { context: { uin: '10001' } }, services }) };
});

it('辅助目录在同库后台排队，当前消息先交付，后台仍最终执行', async () => {
  const order: string[] = [];
  let release!: () => void;
  const blocking = scheduleDatabase(
    '/synthetic/router-priority.db',
    () =>
      new Promise<void>((done) => {
        release = done;
      }),
  );
  fixture.profile.mockImplementation(async () =>
    scheduleDatabase('/synthetic/router-priority.db', async () => {
      order.push('directory');
      return [];
    }),
  );
  fixture.latest.mockImplementation(async () =>
    scheduleDatabase('/synthetic/router-priority.db', async () => {
      order.push('message');
      return [];
    }),
  );
  const api = accountRouter.createCaller({});
  const directory = api.listProfiles({ limit: 2000 });
  const message = api.listLatest({ kind: 'group', conv: '777', deferReplyMedia: true });
  await new Promise((done) => setTimeout(done, 10));
  release();
  await Promise.all([blocking, directory, message]);
  expect(order).toEqual(['message', 'directory']);
  expect(fixture.latest).toHaveBeenCalledWith(
    '777',
    50,
    expect.objectContaining({ deferReplyMedia: true }),
  );
});

it('取消先于首屏请求到达时不执行消息 SQL，下一代请求仍可读取', async () => {
  const api = accountRouter.createCaller({});
  const readWindow = { owner: '11111111-1111-4111-8111-111111111111', generation: 1 };
  fixture.latest.mockClear();
  await api.cancelMessageRead({ readWindow });
  await expect(api.listLatest({ kind: 'group', conv: '777', readWindow })).rejects.toThrow();
  expect(fixture.latest).not.toHaveBeenCalled();
  fixture.latest.mockResolvedValue([]);
  expect(
    await api.listLatest({
      kind: 'group',
      conv: '777',
      readWindow: { ...readWindow, generation: 2 },
    }),
  ).toEqual([]);
});

it('引用后补沿用正文的 IPC 形态：字节转 hex，大整数转字符串', async () => {
  fixture.media.mockResolvedValue([
    {
      msgId: '1',
      elements: [
        {
          type: 'pic',
          data: {
            elementId: 9007199254740993n,
            md5: Buffer.from([0, 255]),
          },
        },
      ],
    },
  ]);
  const rows = await accountRouter
    .createCaller({})
    .replyMedia({ kind: 'group', conv: '777', msgIds: ['1'] });
  expect(rows).toEqual([
    {
      msgId: '1',
      elements: [
        {
          type: 'pic',
          data: {
            elementId: '9007199254740993',
            md5: '00ff',
          },
        },
      ],
    },
  ]);
});
