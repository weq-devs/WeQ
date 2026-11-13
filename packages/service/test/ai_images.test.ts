import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AccountSession } from '@weq/account';
import { AiImageProcessor } from '@weq/agentlab';
import { AssistantService } from '../src/account/assistant';
import { ConversationStore } from '../src/account/agentlab_conversation';
import { TokenUsageStore } from '../src/account/agentlab_usage';
import { IntentSenseService } from '../src/account/intent_sense';
import { AgentLabConfigService } from '../src/bootstrap/agentlab_config';
import {
  snapshotWeqApiSettings,
  snapshotWeqSettings,
  validateWeqApiSettings,
  validateWeqAppSettings,
} from '../src/bootstrap/backup_settings';
import { configFixture } from './support/user_config';
import { messageImageRefs, trainingImageText } from '../src/common/ai_message_images';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function directory() {
  const root = mkdtempSync(join(tmpdir(), 'weq-ai-images-'));
  roots.push(root);
  return root;
}
const endpoint = { baseUrl: 'https://fixture.invalid', apiKey: 'fixture', model: 'visual' };
const image = { id: 'asset.png', path: '/synthetic/asset.png', name: '合成图片' };

it('训练语料只纳入成功识别的内容，不把失败提示或筛图说明当成本人发言', () => {
  expect(
    trainingImageText('原文', [
      { id: 'one', mode: 'vision', status: 'failed', notes: ['处理失败'] },
      { id: 'two', mode: 'ocr', status: 'skipped', notes: ['无文字'] },
      { id: 'three', mode: 'vision', status: 'read', text: '真实图片内容', notes: [] },
    ]),
  ).toBe('原文\n[图片]\n[图片]\n[图片内容]真实图片内容');
});

it('图片偏好与默认视觉模型独立全局保存、备份，旧设置不自动选择模型', () => {
  const f = configFixture();
  const config = new AgentLabConfigService(f.service);
  expect(f.service.getSettings().aiImages).toMatchObject({
    assistant: 'vision',
    cloneChat: 'vision',
    cloneTraining: 'placeholder',
    intent: 'placeholder',
    profile: 'placeholder',
    suggestions: 'placeholder',
  });
  expect(config.getDefaultVisionModelStatus().ref).toBeNull();
  f.service.setSettings({
    agentLab: {
      providers: [
        {
          id: 'visual',
          name: '合成视觉',
          vendor: 'custom',
          baseUrl: endpoint.baseUrl,
          apiKey: 'fixture',
          models: [{ id: 'visual', capabilities: ['chat', 'vision'] }],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    },
  });
  config.setDefaultVisionModel({ providerId: 'visual', model: 'visual' });
  f.service.setSettings({ aiImages: { profile: 'ocr' } });
  const reopened = f.open().getSettings();
  expect(reopened.aiImages.profile).toBe('ocr');
  expect(reopened.agentLab.defaultModel).toBeNull();
  expect(reopened.agentLab.defaultVisionModel).toEqual({ providerId: 'visual', model: 'visual' });
  expect(() => validateWeqApiSettings(snapshotWeqApiSettings(reopened))).not.toThrow();
  expect(() => validateWeqAppSettings(snapshotWeqSettings(reopened))).not.toThrow();
  expect(() => validateWeqAppSettings({ aiImages: { assistant: 'placeholder' } })).toThrow();
  expect(() => validateWeqAppSettings({ aiImages: { intent: 'unsupported' } })).toThrow();
  config.setDefaultVisionModel(null);
  expect(config.resolveVisionEndpoint()).toBeNull();
});

function assistantFixture() {
  const root = directory();
  const ocr = vi.fn(async () => ({ text: '合成截图文字' }));
  const processor = new AiImageProcessor({
    mode: () => 'vision',
    vision: () => endpoint,
    load: async () => ({ dataUrl: 'data:image/png;base64,synthetic', key: 'synthetic' }),
    ocr,
  });
  const conversations = new ConversationStore(join(root, 'conversation.json'));
  const service = new AssistantService(
    root,
    () => endpoint,
    new TokenUsageStore(join(root, 'usage.json')),
    conversations,
    { specs: () => [], run: async () => null, images: processor },
  );
  service.setConfig({ model: { providerId: 'fixture', model: 'visual' } });
  const api = service as unknown as {
    callApiStream: (...args: unknown[]) => Promise<{ content: string; toolCalls?: [] }>;
    generateTitle: () => Promise<string>;
  };
  vi.spyOn(api, 'generateTitle').mockResolvedValue('合成看图');
  const calls = vi.spyOn(api, 'callApiStream').mockResolvedValue({ content: '已看图' });
  return { root, service, calls, ocr };
}
it('助手直接看图失败时只在未输出前回退 OCR，历史只保存引用并保留真实处理方式', async () => {
  const f = assistantFixture();
  f.calls.mockRejectedValueOnce(new Error('图片参数不支持'));
  const session = f.service.createSession();
  await f.service.chat(session.id, '', undefined, undefined, [image]);
  expect(f.calls).toHaveBeenCalledTimes(2);
  expect(f.ocr).toHaveBeenCalledOnce();
  expect(JSON.stringify(f.calls.mock.calls[0]?.[1])).toContain('image_url');
  expect(JSON.stringify(f.calls.mock.calls[1]?.[1])).not.toContain('image_url');
  expect(JSON.stringify(f.calls.mock.calls[1]?.[1])).toContain('合成截图文字');
  expect(f.service.getConversation(session.id)[0]).toMatchObject({
    images: [image],
    imageOutcomes: [{ mode: 'ocr', status: 'read' }],
  });
  expect(readFileSync(join(f.root, 'conversation.json'), 'utf8')).not.toContain('base64');
});
it('助手已有流式文字后不重放请求、不回退 OCR', async () => {
  const f = assistantFixture();
  const session = f.service.createSession();
  f.calls.mockImplementationOnce(async (...args) => {
    (args[3] as (step: unknown) => void)({ kind: 'text_delta', text: '已开始回答' });
    throw new Error('连接中断');
  });
  await expect(f.service.chat(session.id, '看图', undefined, undefined, [image])).rejects.toThrow(
    '连接中断',
  );
  expect(f.calls).toHaveBeenCalledOnce();
  expect(f.ocr).not.toHaveBeenCalled();
});
it('商城表情与图片引用保留独立定位，并兼容漫游的十六进制标识', () => {
  const refs = messageImageRefs(
    [
      { kind: 'text' },
      { kind: 'mface', emojiPackId: 123, marketEmoticonId: new Uint8Array(16).fill(0xab) },
      { kind: 'pic', fileName: 'fixture.png', subType: 1 },
      { kind: 'mface', emojiPackId: 456, marketEmoticonIdHex: 'cd'.repeat(16) },
    ],
    'c2c',
    'peer',
    '1',
    1700000000000,
  );
  expect(refs).toMatchObject([
    { id: '1:0', market: { pack: '123', hash: 'ab'.repeat(16) } },
    { id: '1:1', chat: { index: 0 }, media: { emoji: true } },
    { id: '1:2', market: { pack: '456', hash: 'cd'.repeat(16) } },
  ]);
});

it.each(['pic', 'mface'])('%s 消息进入意图分析；更换图片策略后不复用旧派生缓存', async (kind) => {
  let revision = 'first';
  const prepared = vi.fn(async () => ({
    text: '[图片] OCR 合成文字',
    content: '[图片] OCR 合成文字',
    outcomes: [],
  }));
  const message = {
    msgId: 1n,
    msgSeq: 1n,
    senderUid: 'peer',
    senderUin: 10001n,
    sendTime: 1700000000n,
    elements: [
      {
        kind,
        fileName: 'fixture.png',
        fileToken: 'token',
        imgWidth: 100,
        imgHeight: 100,
        emojiPackId: 123,
        marketEmoticonId: new Uint8Array(16).fill(0xab),
      },
    ],
  };
  const session = {
    context: { uin: 10000n },
    uidMap: { sortNoByUid: () => undefined },
    c2cMsgs: { listLatest: async () => [message] },
  } as unknown as AccountSession;
  const analyze = vi.fn(async (_text: string) => ({
    intent: 'share' as const,
    emotion: 'neutral' as const,
    intensity: 30,
    sentiment: 0,
    confidence: 0.9,
  }));
  const service = new IntentSenseService(session, directory(), {
    images: { prepare: prepared, revision: () => revision },
    localEngine: { ready: true, analyze, inferMbti: async () => null },
  });
  await service.setConfig({ enabled: true, engine: 'local', analysisContextMessages: 0 });
  expect((await service.ensureAnalysis('c2c', 'peer', 1)).analyzed).toBe(1);
  expect(prepared).toHaveBeenCalledWith(
    expect.objectContaining({
      feature: 'intent',
      images: [
        expect.objectContaining(
          kind === 'pic'
            ? { chat: { kind: 'c2c', conv: 'peer', msgId: '1', index: 0 } }
            : { market: { pack: '123', hash: 'ab'.repeat(16) } },
        ),
      ],
    }),
  );
  expect(analyze.mock.calls[0]?.[0]).toContain('OCR 合成文字');
  expect(await service.analyzeMessage('c2c', 'peer', '1', { manual: true })).not.toBeNull();
  expect(analyze).toHaveBeenCalledTimes(2);
  revision = 'second';
  service.getStatus();
  expect((await service.ensureAnalysis('c2c', 'peer', 1)).analyzed).toBe(1);
  expect(analyze).toHaveBeenCalledTimes(3);
});

it.each([
  { mode: 'ocr', split: true },
  { mode: 'vision', split: true },
  { mode: 'ocr', split: false },
  { mode: 'vision', split: false },
] as const)(
  '推荐回复在 $mode 图片处理期间记录字符进度（跨消息：$split），完成后保存日志',
  async ({ mode, split }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const processor = new AiImageProcessor({
      mode: () => mode,
      vision: () => endpoint,
      load: async () => ({ dataUrl: 'data:image/png;base64,synthetic', key: 'synthetic' }),
      ocr: async () => {
        await gate;
        return { text: '合成文字' };
      },
    });
    const fetchMock = vi.fn(async () => {
      await gate;
      return new Response(JSON.stringify({ choices: [{ message: { content: '合成画面' } }] }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const message = (id: bigint) => ({
      msgId: id,
      msgSeq: id,
      senderUid: 'peer',
      senderUin: 10001n,
      sendTime: 1700000000n + id,
      elements: [{ kind: 'pic', fileName: 'fixture.png' }],
    });
    const session = {
      context: { uin: 10000n },
      uidMap: { sortNoByUid: () => undefined },
      c2cMsgs: {
        listLatest: async () =>
          split
            ? [message(2n), message(1n)]
            : [{ ...message(1n), elements: [...message(1n).elements, ...message(1n).elements] }],
      },
    } as unknown as AccountSession;
    const root = directory();
    const service = new IntentSenseService(session, root, { images: processor });
    await service.setConfig({ suggestionsEnabled: true });
    const pending = service.getSuggestions('c2c', 'peer');
    try {
      await vi.waitFor(() => {
        const details = service.getSuggestionDetails('c2c', 'peer');
        expect(details?.progress?.stage).toBe('图片处理');
        expect(details?.trace?.logs?.at(-1)?.text).toContain('[----------] 0/2');
        expect(details?.trace?.logs?.at(-1)?.text).toContain(mode === 'ocr' ? 'OCR' : 'visual');
      });
    } finally {
      release();
      await pending;
    }
    const details = service.getSuggestionDetails('c2c', 'peer');
    const logs = details?.trace?.logs ?? [];
    expect(logs.some((line) => line.text.includes('[#####-----] 1/2'))).toBe(true);
    expect(logs.some((line) => line.text.includes('[##########] 2/2'))).toBe(true);
    expect(logs.some((line) => line.text.includes('耗时'))).toBe(true);
    expect(logs.map((line) => line.seq)).toEqual(logs.map((_, index) => index + 1));
    expect(JSON.stringify(logs)).not.toContain('base64');
    expect(
      new IntentSenseService(session, root).getSuggestionDetails('c2c', 'peer', details?.entry?.id)
        ?.trace?.logs,
    ).toEqual(logs);
  },
);

it('停止图片 OCR 后，迟到结果不再推进字符进度或覆盖已停止状态', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ocr = vi.fn(async () => {
    await gate;
    return { text: '迟到文字' };
  });
  const processor = new AiImageProcessor({
    mode: () => 'ocr',
    vision: () => null,
    load: async () => {
      throw new Error('不应读取视觉图片');
    },
    ocr,
  });
  const session = {
    context: { uin: 10000n },
    uidMap: { sortNoByUid: () => undefined },
    c2cMsgs: {
      listLatest: async () => [
        {
          msgId: 1n,
          msgSeq: 1n,
          senderUid: 'peer',
          senderUin: 10001n,
          sendTime: 1700000000n,
          elements: [{ kind: 'pic', fileName: 'fixture.png' }],
        },
      ],
    },
  } as unknown as AccountSession;
  const service = new IntentSenseService(session, directory(), { images: processor });
  await service.setConfig({ suggestionsEnabled: true });
  const pending = service.getSuggestions('c2c', 'peer');
  try {
    await vi.waitFor(() => expect(ocr).toHaveBeenCalledOnce());
    expect(service.stopSuggestions('c2c', 'peer')).toBe(true);
  } finally {
    release();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  }
  const details = service.getSuggestionDetails('c2c', 'peer');
  expect(details?.progress?.status).toBe('stopped');
  expect(details?.trace?.logs?.at(-1)?.stage).toBe('已停止');
  expect(details?.trace?.logs?.some((line) => line.text.includes('[##########]'))).toBe(false);
});
