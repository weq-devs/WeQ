// @vitest-environment node
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { observableToPromise } from '@trpc/server/observable';
import { type MsgService, VOICE_MODELS } from '@weq/service';
import { accountRouter } from '../src/main/ipc/routers/account';
import { bootstrapRouter } from '../src/main/ipc/routers/bootstrap';
import { SentVoiceTranscripts } from '../src/main/sent_voice_transcripts';
import { UNKNOWN_NETWORK } from '@weq/service/data-saver';
import { updateTransferPolicy } from '@weq/service/transfer-policy';

const state = vi.hoisted(() => ({
  switched: false,
  downloaded: true,
  infer: vi.fn(),
  write: vi.fn(async () => true),
  read: vi.fn(),
  find: vi.fn(async () => ({ source: '/synthetic/voice.silk' })),
  download: vi.fn(),
}));
vi.mock('../src/main/context/app_context', () => {
  const services = {
    accountConfig: { getRecord: () => ({ configId: 'source-a' }) },
    fileSearch: { findFile: state.find },
    mediaDownload: { download: state.download },
    msgs: { setPttTranscript: state.write, getRawElements: state.read },
  };
  const context = {
    account: { context: { uin: '10001' } },
    get services() {
      return state.switched ? { ...services } : services;
    },
    bootstrap: {
      userConfig: { getLocalModelId: () => VOICE_MODELS[0]!.id, cacheDir: () => tmpdir() },
      voiceTranscribe: {
        getModelStatus: () => ({ downloaded: state.downloaded }),
        resolveModelPaths: () => ({
          model: '/synthetic/model.onnx',
          tokens: '/synthetic/tokens.txt',
        }),
      },
    },
  };
  return {
    accountEventBus: new EventEmitter(),
    getAppContext: () => context,
    requireBootstrap: () => context.bootstrap,
  };
});
vi.mock('../src/main/voice', () => ({
  decodeSilkToWav16kBuffer: async () => Buffer.from('synthetic-wav'),
}));
vi.mock('../src/main/transcribe/engine', () => ({ transcribeWav: state.infer }));
const input = {
  t: 1000,
  name: 'voice.silk',
  msgId: '42',
  expectedAccountUin: '10001',
  expectedAccountConfigId: 'source-a',
};
beforeEach(() => {
  vi.clearAllMocks();
  state.switched = false;
  state.downloaded = true;
  state.infer.mockResolvedValue({ success: true, text: '合成识别结果' });
  state.read.mockReset();
  state.write.mockResolvedValue(true);
});

it('省流量时自动转写只查本地语音，手动转写仍可补取', async () => {
  const api = accountRouter.createCaller({});
  try {
    updateTransferPolicy('always', UNKNOWN_NETWORK);
    await expect(api.transcribeVoice({ ...input, automatic: true })).resolves.toMatchObject({
      success: true,
    });
    expect(state.download).not.toHaveBeenCalled();
    state.find.mockResolvedValueOnce({ source: '' }).mockResolvedValueOnce({ source: '' });
    state.download.mockImplementation((_token, options) =>
      options.localOnly ? null : '/synthetic/voice.silk',
    );
    await expect(
      api.transcribeVoice({ ...input, token: 'fixture', automatic: true }),
    ).resolves.toMatchObject({ deferred: true, success: false });
    await expect(api.transcribeVoice({ ...input, token: 'fixture' })).resolves.toMatchObject({
      success: true,
    });
    expect(state.download.mock.calls.map(([, options]) => options.localOnly === true)).toEqual([
      true,
      false,
    ]);
  } finally {
    updateTransferPolicy('auto', UNKNOWN_NETWORK);
  }
});

function makeRecordingWav(sampleRate = 16_000) {
  const wav = Buffer.alloc(46);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(38, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(2, 40);
  return new Uint8Array(wav);
}

it('未发送的录音直接用本地模型转写，缺模型和不合规采样率有明确结果', async () => {
  const api = bootstrapRouter.createCaller({});
  const wav = makeRecordingWav();
  expect(await observableToPromise(await api.transcribeRecording({ wav })).promise).toMatchObject({
    success: true,
    text: '合成识别结果',
  });
  expect(state.infer).toHaveBeenCalledWith(
    Buffer.from(wav),
    { model: '/synthetic/model.onnx', tokens: '/synthetic/tokens.txt' },
    expect.anything(),
  );
  expect(state.write).not.toHaveBeenCalled();
  expect(state.find).not.toHaveBeenCalled();
  state.infer.mockClear();
  await expect(api.transcribeRecording({ wav: makeRecordingWav(24_000) })).rejects.toThrow(
    '录音格式或时长无效',
  );
  state.downloaded = false;
  expect(await observableToPromise(await api.transcribeRecording({ wav })).promise).toMatchObject({
    success: false,
  });
  expect(state.infer).not.toHaveBeenCalled();
});

it('取消录音转写会中止识别，已取消的结果不会发布，录音可以再次转写', async () => {
  const api = bootstrapRouter.createCaller({});
  const wav = makeRecordingWav();
  let signal: AbortSignal | undefined;
  let finish: ((result: { success: boolean; text: string }) => void) | undefined;
  state.infer.mockImplementationOnce((_wav, _model, options) => {
    signal = options.signal;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const result = await api.transcribeRecording({ wav });
  const receive = vi.fn();
  const task = result.subscribe({ next: receive });
  await vi.waitFor(() => expect(signal).toBeDefined());
  task.unsubscribe();
  expect(signal?.aborted).toBe(true);
  finish?.({ success: true, text: '已取消的结果' });
  expect(await observableToPromise(await api.transcribeRecording({ wav })).promise).toMatchObject({
    success: true,
    text: '合成识别结果',
  });
  expect(receive).not.toHaveBeenCalled();
});
it('识别结果返回并写回原消息，保留原有调用兼容性', async () => {
  const result = await accountRouter.createCaller({}).transcribeVoice(input);
  expect(result).toMatchObject({ success: true, text: '合成识别结果' });
  expect(state.write).toHaveBeenCalledWith(
    42n,
    'voice.silk',
    '合成识别结果',
    expect.objectContaining({ ifEmpty: false }),
  );
});
it('已有原文时跳过自动识别，识别中的迟到结果也沿用已保存的原文', async () => {
  const api = accountRouter.createCaller({});
  const stored = { elements: [{ kind: 'ptt', fileName: input.name, pttTranscript: '合成原文' }] };
  state.read.mockResolvedValueOnce(stored);
  expect(await api.transcribeVoice({ ...input, automatic: true })).toMatchObject({
    success: true,
    text: '合成原文',
  });
  expect(state.infer).not.toHaveBeenCalled();

  state.read.mockResolvedValueOnce(null).mockResolvedValueOnce(stored);
  state.write.mockResolvedValueOnce(false);
  expect(await api.transcribeVoice({ ...input, automatic: true })).toMatchObject({
    success: true,
    text: '合成原文',
  });
  expect(state.write).toHaveBeenCalledWith(
    42n,
    input.name,
    '合成识别结果',
    expect.objectContaining({ ifEmpty: true }),
  );
});
it('包内语音有相同消息 ID 时也只返回转写，不写 QQ 消息', async () => {
  const result = await accountRouter.createCaller({}).transcribeVoice({
    ...input,
    forward: { carrierId: '512', kind: 'group', conv: '12345', resId: 'sample-record' },
  });
  expect(result).toMatchObject({ success: true, text: '合成识别结果' });
  expect(state.infer).toHaveBeenCalledOnce();
  expect(state.write).not.toHaveBeenCalled();
});
it('排队期间切换账号或数据源后拒绝旧请求，不启动识别', async () => {
  for (const binding of [
    { expectedAccountUin: '20002' },
    { expectedAccountConfigId: 'source-b' },
  ]) {
    await expect(
      accountRouter.createCaller({}).transcribeVoice({ ...input, ...binding }),
    ).rejects.toThrow('已切换');
  }
  expect(state.find).not.toHaveBeenCalled();
  expect(state.infer).not.toHaveBeenCalled();
});
it('识别中切换数据源后不写回旧账号', async () => {
  state.infer.mockImplementationOnce(async () => {
    state.switched = true;
    return { success: true, text: '迟到结果' };
  });
  expect(await accountRouter.createCaller({}).transcribeVoice(input)).toMatchObject({
    success: false,
  });
  expect(state.write).not.toHaveBeenCalled();
});

it('合成原文等待 QQ 同步，重启后按音频回执和消息序号定位实际消息', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weq-sent-voice-'));
  const path = join(dir, 'sent-voice.json');
  const hash = 'a'.repeat(32);
  const fileName = `${hash}.amr`;
  const row = (msgId: bigint, senderUid: string, md5: string) => ({
    msgId,
    msgRandom: 7n,
    senderUid,
    sendTime: BigInt(Math.floor(Date.now() / 1000)),
    elements: [{ type: 'ptt', data: { fileName, isAiVoice: true, md5 } }],
  });
  const msgs = {
    getGroupAfter: vi.fn(),
    getSentVoiceRows: vi.fn(),
    getRawElements: state.read,
    setPttTranscript: state.write,
  };
  const open = () =>
    new SentVoiceTranscripts(path, msgs as unknown as MsgService, 'self', () => true);
  let queue = open();
  try {
    queue.remember({ kind: 'group', conv: '1', at: Date.now(), text: 'AI 原文', hash, seq: '10' });
    queue.remember({
      kind: 'c2c',
      conv: 'peer',
      at: Date.now(),
      text: 'TTS 原文',
      hash: '',
      seq: '20',
      random: '7',
    });
    await queue.dispose();
    msgs.getGroupAfter.mockResolvedValue([
      row(11n, 'other', hash),
      row(12n, 'self', 'b'.repeat(32)),
      row(13n, 'self', hash),
    ]);
    msgs.getSentVoiceRows.mockResolvedValue([row(20n, 'other', hash), row(21n, 'self', hash)]);
    state.read.mockResolvedValue({
      elements: [{ kind: 'ptt', fileName, pttTranscript: '自动结果' }],
    });
    queue = open();
    await queue.flush();
    expect(msgs.getGroupAfter).toHaveBeenCalledWith('1', 10n, 200, { deferReplyMedia: true });
    expect(msgs.getSentVoiceRows).toHaveBeenCalledWith('c2c', 'peer', 20n);
    expect(state.write.mock.calls.map((call) => call.slice(0, 3))).toEqual([
      [13n, fileName, 'AI 原文'],
      [21n, fileName, 'TTS 原文'],
    ]);
    await queue.flush();
    expect(state.write).toHaveBeenCalledTimes(2);
  } finally {
    await queue.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
