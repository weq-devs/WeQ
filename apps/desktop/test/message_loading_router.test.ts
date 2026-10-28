// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { scheduleDatabase } from '@weq/db';
import { accountRouter } from '../src/main/ipc/routers/account';

const fixture = vi.hoisted(() => ({
  profile: vi.fn(),
  latest: vi.fn(),
  media: vi.fn(),
  cached: vi.fn(),
  switched: false,
}));
vi.mock('../src/main/context/app_context', () => {
  const services = {
    accountConfig: { getRecord: () => ({ configId: 'fixture' }) },
    profile: { listProfiles: (...args: unknown[]) => fixture.profile(...args) },
    msgs: {
      getGroupLatest: (...args: unknown[]) => fixture.latest(...args),
      getReplyMedia: (...args: unknown[]) => fixture.media(...args),
    },
    gapHistory: { cachedTimeline: (...args: unknown[]) => fixture.cached(...args) },
  };
  const other = { ...services };
  return {
    getAppContext: () => ({
      account: { context: { uin: '10001' } },
      services: fixture.switched ? other : services,
    }),
  };
});
beforeEach(() => {
  vi.clearAllMocks();
  fixture.switched = false;
  fixture.latest.mockResolvedValue([]);
  fixture.cached.mockResolvedValue([]);
});

it('未打开宽容服务或原生平台时，既有配置与隔离目录读取保持空快照返回', async () => {
  const api = accountRouter.createCaller({});
  expect(await api.getDbTolerance()).toMatchObject({ level: 0, entries: [] });
  expect(await api.listSalvageQuarantine()).toEqual([]);
});

const local = () => ({
  msgId: 1n,
  msgSeq: 1n,
  msgRandom: 0n,
  senderUid: 'u_peer',
  targetGroupCode: '777',
  senderUin: 20002n,
  sendTime: 1n,
  elements: [],
  deletedKind: 'qq',
});
const readWindow = { owner: '22222222-2222-4222-8222-222222222222', generation: 1 };

it('冷首屏在慢漫游缓存之前交付本地正文与删除状态，随后发送完整合并页', async () => {
  let release!: (rows: unknown[]) => void;
  fixture.latest.mockResolvedValue([local()]);
  fixture.cached.mockImplementation(
    () =>
      new Promise((done) => {
        release = done;
      }),
  );
  const stream = await accountRouter
    .createCaller({})
    .latestPage({ kind: 'group', conv: '777', readWindow });
  const stages: { complete: boolean; rows: { msgSeq: string; deletedKind?: string }[] }[] = [];
  let finish!: () => void;
  const ended = new Promise<void>((done) => {
    finish = done;
  });
  const sub = stream.subscribe({ next: (stage) => stages.push(stage), complete: finish });
  try {
    await vi.waitFor(() => expect(stages).toHaveLength(1));
    expect(stages[0]).toMatchObject({
      complete: false,
      rows: [{ msgSeq: '1', deletedKind: 'qq' }],
    });
    release([
      {
        kind: 'group',
        conv: '777',
        msgId: '2',
        msgSeq: '2',
        senderUid: 'u_peer',
        senderUin: '20002',
        sendTime: '2',
        elements: [],
      },
    ]);
    await ended;
    expect(stages[1]?.complete).toBe(true);
    expect(stages[1]?.rows.map((row) => row.msgSeq)).toEqual(['2', '1']);
    expect(fixture.latest).toHaveBeenCalledOnce();
  } finally {
    sub.unsubscribe();
  }
});
it('切换数据源后不发送旧正文', async () => {
  let release!: (rows: unknown[]) => void;
  fixture.latest.mockImplementation(
    () =>
      new Promise((done) => {
        release = done;
      }),
  );
  const stream = await accountRouter
    .createCaller({})
    .latestPage({ kind: 'group', conv: '777', readWindow: { ...readWindow, generation: 2 } });
  const next = vi.fn();
  let fail!: (error: unknown) => void;
  const failed = new Promise<unknown>((done) => {
    fail = done;
  });
  const sub = stream.subscribe({ next, error: fail });
  try {
    fixture.switched = true;
    release([local()]);
    expect(await failed).toBeInstanceOf(Error);
    expect(next).not.toHaveBeenCalled();
  } finally {
    sub.unsubscribe();
  }
});

it('最终页与本地页相同时只发送收尾标记，不重复传输正文', async () => {
  fixture.latest.mockResolvedValue([local()]);
  const stream = await accountRouter
    .createCaller({})
    .latestPage({ kind: 'group', conv: '777', readWindow: { ...readWindow, generation: 3 } });
  const stages: unknown[] = [];
  await new Promise<void>((done, fail) =>
    stream.subscribe({ next: (stage) => stages.push(stage), complete: done, error: fail }),
  );
  expect(stages).toHaveLength(2);
  expect(stages[1]).toEqual({ complete: true, rows: [], reuseLocal: true });
});

it('本地页为空时不提前发送空页，最终空结果仍正确收尾', async () => {
  let release!: () => void;
  fixture.cached.mockImplementation(
    () =>
      new Promise((done) => {
        release = () => done([]);
      }),
  );
  const stream = await accountRouter
    .createCaller({})
    .latestPage({ kind: 'group', conv: '777', readWindow: { ...readWindow, generation: 4 } });
  const next = vi.fn();
  let finish!: () => void;
  const ended = new Promise<void>((done) => {
    finish = done;
  });
  const sub = stream.subscribe({ next, complete: finish });
  try {
    await vi.waitFor(() => expect(fixture.cached).toHaveBeenCalledOnce());
    expect(next).not.toHaveBeenCalled();
    release();
    await ended;
    expect(next).toHaveBeenCalledWith({ complete: true, rows: [] });
  } finally {
    sub.unsubscribe();
  }
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
