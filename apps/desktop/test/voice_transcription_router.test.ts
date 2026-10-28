// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { VOICE_MODELS } from '@weq/service';
import { accountRouter } from '../src/main/ipc/routers/account';

const state = vi.hoisted(() => ({
  switched: false,
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
        getModelStatus: () => ({ downloaded: true }),
        resolveModelPaths: () => ({
          model: '/synthetic/model.onnx',
          tokens: '/synthetic/tokens.txt',
        }),
      },
    },
  };
  return { getAppContext: () => context };
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
  state.infer.mockResolvedValue({ success: true, text: '合成识别结果' });
});
it('识别结果返回并写回原消息，保留原有调用兼容性', async () => {
  const result = await accountRouter.createCaller({}).transcribeVoice(input);
  expect(result).toMatchObject({ success: true, text: '合成识别结果' });
  expect(state.write).toHaveBeenCalledWith(42n, 'voice.silk', '合成识别结果');
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
