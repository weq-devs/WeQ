// @vitest-environment node
import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
import { VOICE_MODELS } from '@weq/service';
import { accountRouter } from '../src/main/ipc/routers/account';
import { bootstrapRouter } from '../src/main/ipc/routers/bootstrap';

const state = vi.hoisted(() => ({
  switched: false,
  downloaded: true,
  infer: vi.fn(),
  write: vi.fn(async () => true),
  find: vi.fn(async () => ({ source: '/synthetic/voice.silk' })),
}));
vi.mock('../src/main/context/app_context', () => {
  const services = {
    accountConfig: { getRecord: () => ({ configId: 'source-a' }) },
    fileSearch: { findFile: state.find },
    msgs: { setPttTranscript: state.write },
  };
  const context = {
    account: { context: { uin: '10001' } },
    get services() {
      return state.switched ? { ...services } : services;
    },
    bootstrap: {
      userConfig: { getLocalModelId: () => VOICE_MODELS[0]!.id },
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
  expect(await api.transcribeRecording({ wav })).toMatchObject({
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
  expect(await api.transcribeRecording({ wav })).toMatchObject({ success: false });
  expect(state.infer).not.toHaveBeenCalled();
});
it('识别结果返回并写回原消息，保留原有调用兼容性', async () => {
  const result = await accountRouter.createCaller({}).transcribeVoice(input);
  expect(result).toMatchObject({ success: true, text: '合成识别结果' });
  expect(state.write).toHaveBeenCalledWith(42n, 'voice.silk', '合成识别结果');
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
