// @vitest-environment node
import { access, readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import type { AppContext } from '../src/main/context/app_context';
import type { OneBotBackend, BridgeMessage } from '../src/main/onebot/server';

const state = vi.hoisted(() => ({
  backends: [] as OneBotBackend[],
  delivered: [] as BridgeMessage[],
  hook: null as null | { onNewMessages(change: unknown): Promise<void> },
  unmount: vi.fn(),
}));
vi.mock('@weq/service', () => ({
  getLogger: () => ({ child: () => ({ info() {}, warn() {} }) }),
  toRenderElements: (elements: unknown) => elements,
  createNtMsgDbHook: (_session: unknown, hook: typeof state.hook) => {
    state.hook = hook;
    return hook;
  },
  DbWatchService: class {
    mount() {
      return { unmount: state.unmount };
    }
  },
}));
vi.mock('../src/main/onebot/server', () => ({
  OneBotServer: class {
    unsubscribe?: () => void;
    constructor(public backend: OneBotBackend) {
      state.backends.push(backend);
    }
    async start() {
      await this.backend.self();
      this.unsubscribe = this.backend.subscribe((msg) => state.delivered.push(msg));
      return 1;
    }
    stop() {
      this.unsubscribe?.();
      this.unsubscribe = undefined;
    }
    mediaUrl() {
      return 'http://127.0.0.1/synthetic-media';
    }
    reference() {
      return -100;
    }
  },
}));
import { applyOneBot, stopOneBot } from '../src/main/onebot/runtime';

afterEach(() => {
  stopOneBot();
  state.backends.length = 0;
  state.delivered.length = 0;
  state.hook = null;
  vi.clearAllMocks();
});
async function setup() {
  const onlineRecord = { qqOnline: true, qqPid: 1000 };
  const sendElements = vi.fn().mockResolvedValue({
    ok: true,
    random: 1,
    timestamp: 100,
    groupSequence: 11,
    privateSequence: 88,
  });
  const sendFile = vi.fn().mockResolvedValue({ ok: true, sent: true, fileId: 'file-1' });
  const ctx = {
    platform: { native: { ntHelper: { hasSsoSession: async () => true } } },
    bootstrap: { userConfig: { getSettings: () => ({ autoAttachQq: true }) } },
    account: { context: { uin: 99 }, uidMap: { uinByUid: () => 99n } },
    accountIsStatic: false,
    services: {
      accountConfig: { getRecord: () => onlineRecord },
      profile: {
        getSelfProfile: async () => ({ nick: 'Self' }),
        getProfile: async () => ({ nick: 'Peer' }),
      },
      messageSend: { sendElements, sendFile },
      interaction: { setInputStatus: vi.fn() },
    },
  } as unknown as AppContext;
  await applyOneBot(ctx, { enabled: true, port: 1, token: 'synthetic' });
  return { ctx, backend: state.backends.at(-1)!, sendElements, sendFile, onlineRecord };
}

it('reports actual QQ offline status rather than just a listening WebSocket', async () => {
  const f = await setup();
  expect(await f.backend.status()).toEqual({ online: true, good: true });
  f.onlineRecord.qqOnline = false;
  expect(await f.backend.status()).toEqual({ online: false, good: false });
  stopOneBot();
  expect(await f.backend.status()).toEqual({ online: false, good: false });
});

it('uses the distinct QQ quote pointer and validates all outgoing segments before sending', async () => {
  const f = await setup();
  const target = { peerType: 'c2c' as const, targetId: '7' };
  await f.backend.send(target, [{ type: 'text', data: { text: 'reply' } }], {
    ...target,
    key: 'incoming',
    sequence: 23,
    senderUin: 7,
    time: 100,
    nickname: 'Peer',
    message: [],
  });
  expect(f.sendElements).toHaveBeenCalledWith({
    ...target,
    elements: [
      { kind: 'reply', origMsgSeq: 23, origSenderUin: 7, origMsgTime: 100 },
      { kind: 'text', textContent: 'reply' },
    ],
  });
  await expect(
    f.backend.send(target, [
      { type: 'text', data: { text: 'hi' } },
      { type: 'unsupported', data: {} },
    ]),
  ).rejects.toThrow('暂不支持');
  expect(f.sendElements).toHaveBeenCalledTimes(1);
});

it('routes files through sendFile and removes only its own temporary material after completion', async () => {
  const f = await setup();
  let temporary = '';
  f.sendFile.mockImplementation(async (params: { path: string }) => {
    temporary = params.path;
    expect(await readFile(params.path, 'utf8')).toBe('hello');
    return { ok: true, sent: true, fileId: 'file-1' };
  });
  await f.backend.send({ peerType: 'group', targetId: '42' }, [
    { type: 'file', data: { file: 'base64://aGVsbG8=', name: 'hello.txt' } },
  ]);
  expect(f.sendElements).not.toHaveBeenCalled();
  expect(f.sendFile).toHaveBeenCalledWith(
    expect.objectContaining({ peerType: 'group', targetId: '42', fileName: 'hello.txt' }),
  );
  await expect(access(temporary)).rejects.toThrow();
});

it('does not send partial mixed-file messages or swallow QQ business rejection', async () => {
  const f = await setup();
  const target = { peerType: 'group' as const, targetId: '42' };
  await expect(
    f.backend.send(target, [
      { type: 'file', data: { file: 'base64://YQ==' } },
      { type: 'text', data: { text: 'no' } },
    ]),
  ).rejects.toThrow('单独发送');
  expect(f.sendFile).not.toHaveBeenCalled();
  f.sendElements.mockResolvedValueOnce({ ok: false, errMsg: 'QQ rejected' });
  await expect(f.backend.send(target, [{ type: 'text', data: { text: 'hi' } }])).rejects.toThrow(
    'QQ rejected',
  );
});

it('maps fresh private rows with clientSeq and native @ segments but ignores self and history', async () => {
  await setup();
  const row = {
    msgId: 9007199254740993123n,
    msgSeq: 800n,
    clientSeq: 23n,
    targetUid: 'peer',
    targetUin: 7n,
    senderUid: 'peer',
    senderUin: 7n,
    sendTime: BigInt(Math.floor(Date.now() / 1000)),
    elements: [
      { type: 'at', data: { atTargetUid: 'self', textContent: '@Self' } },
      { type: 'text', data: { textContent: 'hello' } },
    ],
  };
  await state.hook!.onNewMessages({
    c2c: [row, { ...row, senderUin: 99n }, { ...row, sendTime: 1n }],
    group: [],
  });
  expect(state.delivered).toHaveLength(1);
  expect(state.delivered[0]).toMatchObject({
    sequence: 23,
    targetId: '7',
    message: [
      { type: 'at', data: { qq: '99' } },
      { type: 'text', data: { text: 'hello' } },
    ],
  });
  expect(state.delivered[0]?.key).toContain('9007199254740993123');
});

it('invalidates captured backends on account switch and never starts for a static account', async () => {
  const f = await setup();
  stopOneBot();
  await expect(
    f.backend.send({ peerType: 'c2c', targetId: '7' }, [{ type: 'text', data: { text: 'late' } }]),
  ).rejects.toThrow('切换或关闭');
  expect(f.sendElements).not.toHaveBeenCalled();
  f.ctx.accountIsStatic = true;
  await applyOneBot(f.ctx, { enabled: true, port: 1, token: 'synthetic' });
  expect(state.backends).toHaveLength(1);
  expect(state.unmount).toHaveBeenCalledTimes(1);
});
