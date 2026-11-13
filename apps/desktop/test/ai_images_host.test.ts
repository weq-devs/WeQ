// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_APP_SETTINGS } from '@weq/service';
import { createAccountImagePort, retainAiImage, aiImageAssetPath } from '../src/main/ai_images';

const state = vi.hoisted(() => ({
  context: {} as Record<string, unknown>,
  root: '',
  model: 'local-a',
  retrieve: vi.fn(),
  metadata: vi.fn(),
  local: vi.fn(),
  find: vi.fn(),
  online: vi.fn(),
  usage: vi.fn(),
  globalUsage: vi.fn(),
}));
vi.mock('../src/main/context/app_context', () => ({ getAppContext: () => state.context }));
vi.mock('../src/main/media_protocol', () => ({ resolveChatImageFile: state.retrieve }));
vi.mock('../src/main/image_processor', () => ({ imageMetadata: state.metadata }));
vi.mock('../src/main/ocr/local', () => ({
  resolveLocalOcrModel: () => ({ modelId: state.model, paths: {} }),
  resolveLocalOcrFilterModel: () => null,
  runLocalOcr: state.local,
}));
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAANklEQVRIie3WuQkAQAwDwem/aV0VhgsWnAuMnjVOTwJ6kVy0gqaqWG2qwVmTKaoQeAkdfU3XDzLD/C7nwdQVAAAAAElFTkSuQmCC',
  'base64',
);
let account: object;
let settings: typeof DEFAULT_APP_SETTINGS;
beforeEach(() => {
  vi.clearAllMocks();
  state.root = mkdtempSync(join(tmpdir(), 'weq-ai-host-'));
  state.model = 'local-a';
  settings = structuredClone(DEFAULT_APP_SETTINGS);
  settings.aiImages.assistant = 'ocr';
  settings.ocr.prefilterEnabled = false;
  account = {};
  const imagePath = join(state.root, 'download.png');
  writeFileSync(imagePath, png);
  state.retrieve.mockResolvedValue({ path: imagePath, variant: 'downloaded' });
  state.find.mockResolvedValue({ source: null, thumb: null });
  state.metadata.mockResolvedValue({ width: 32, height: 32 });
  state.online.mockRejectedValue(new Error('QQ 离线'));
  state.local.mockImplementation(async () => ({
    modelId: state.model,
    imageWidth: 32,
    imageHeight: 32,
    blocks: [
      {
        text: state.model,
        rect: { x: 0, y: 0, width: 10, height: 10 },
        quad: [],
        parag: '',
        field2: 99,
      },
    ],
  }));
  const message = {
    sendTime: 1700000000000,
    elements: [
      {
        type: 'pic',
        data: {
          fileName: 'a'.repeat(32) + '.png',
          md5: 'a'.repeat(32),
          fileToken: 'token',
          imgWidth: 32,
          imgHeight: 32,
        },
      },
    ],
  };
  state.context = {
    account,
    services: {
      agentLab: { assetRoot: state.root, recordImageUsage: state.usage },
      accountConfig: { getRecord: () => ({ configId: 'fixture', qqOnline: false }) },
      fileResource: { resolveLocalFile: async (path: string) => path },
      fileSearch: { findFile: state.find },
      msgs: { getC2cMessageById: async () => message },
      chatImageOcr: { recognize: state.online },
    },
    bootstrap: {
      userConfig: {
        getSettings: () => settings,
        cacheDir: (name: string) => {
          const dir = join(state.root, 'cache', name);
          mkdirSync(dir, { recursive: true });
          return dir;
        },
      },
      agentLabConfig: {
        resolveVisionEndpoint: () => ({
          baseUrl: 'https://synthetic.invalid',
          apiKey: 'fixture',
          model: 'vision',
          onUsage: state.globalUsage,
        }),
        getProvider: () => null,
      },
      ocrModels: { getModelStatus: () => ({ downloaded: true }) },
    },
  };
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(state.root, { recursive: true, force: true });
});
const chatImage = { id: '1:0', chat: { kind: 'c2c' as const, conv: 'peer', msgId: '1', index: 0 } };

it('QQ 离线仍通过既有完整取图入口取回像素，不要求用户补图', async () => {
  const result = await createAccountImagePort(account).prepare({
    feature: 'assistant',
    text: '问题',
    images: [chatImage],
  });
  expect(result.text).toContain('local-a');
  expect(state.retrieve).toHaveBeenCalledOnce();
  const query = state.retrieve.mock.calls[0]![0] as URLSearchParams;
  expect(query.get('token')).toBe('token');
  expect(query.get('md5')).toBe('a'.repeat(32));
  expect(state.local).toHaveBeenCalledOnce();
});
it('识别缓存优先，不重复取图；更换本地模型不混用旧文字结果', async () => {
  const port = createAccountImagePort(account);
  await port.prepare({ feature: 'assistant', text: '', images: [chatImage] });
  await port.prepare({ feature: 'assistant', text: '', images: [chatImage] });
  expect(state.retrieve).toHaveBeenCalledOnce();
  expect(state.local).toHaveBeenCalledOnce();
  state.model = 'local-b';
  expect(
    (await port.prepare({ feature: 'assistant', text: '', images: [chatImage] })).text,
  ).toContain('local-b');
  expect(state.local).toHaveBeenCalledTimes(2);
});
it('上传素材使用可迁移引用，保存和读取都限定在当前账号资产内', async () => {
  const path = join(state.root, 'selected.png');
  writeFileSync(path, png);
  const ref = await retainAiImage(path);
  expect(ref.path).toBe(`ai-image:${ref.id}`);
  expect(readFileSync(aiImageAssetPath(ref.id))).toEqual(png);
  const result = await createAccountImagePort(account).prepare({
    feature: 'assistant',
    text: '',
    images: [ref],
  });
  expect(result.outcomes[0]?.status).toBe('read');
  expect(state.online).not.toHaveBeenCalled();
});
it('切号取消旧来源处理，不回退 OCR 到新账号', async () => {
  settings.aiImages.assistant = 'vision';
  state.metadata.mockImplementationOnce(async () => {
    state.context.account = {};
    return { width: 32, height: 32 };
  });
  await expect(
    createAccountImagePort(account).prepare({
      feature: 'assistant',
      text: '',
      images: [chatImage],
    }),
  ).rejects.toThrow('账号已切换');
  expect(state.local).not.toHaveBeenCalled();
});
it('视觉调用计入当前功能，不误记为连接测试', async () => {
  settings.aiImages.assistant = 'vision';
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '合成画面' } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        ),
    ),
  );
  const result = await createAccountImagePort(account).prepare({
    feature: 'assistant',
    text: '问题',
    images: [chatImage],
  });
  expect(result.text).toContain('合成画面');
  expect(state.usage).toHaveBeenCalledWith(
    expect.objectContaining({ feature: 'assistant-image', kind: 'vision' }),
    expect.objectContaining({ feature: 'assistant' }),
  );
  expect(state.globalUsage).not.toHaveBeenCalled();
});
