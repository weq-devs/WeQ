import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AccountSession } from '@weq/account';
import type { C2cMsg } from '@weq/db';
import { AiImageProcessor, GROUP_SUPPLEMENT_THRESHOLD, type AiImageMode } from '@weq/agentlab';
import {
  AgentLabService,
  type AgentLabMediaDeps,
  type EndpointResolver,
} from '../src/account/agentlab';
import { makeBackupPersona } from './fixtures/backup_persona';

const mocks = vi.hoisted(() => ({ card: vi.fn() }));
vi.mock('@weq/agentlab', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weq/agentlab')>()),
  extractPersonaCard: mocks.card,
  extractFewShots: async () => [],
  extractExpressions: async () => [],
  extractStyleVariants: async () => [],
  renderProfileChunks: () => [],
}));
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each(['placeholder', 'ocr', 'vision', 'fallback', 'unconfigured', 'failed', 'skipped'] as const)(
  '表情训练遵循共用图片偏好（%s），复用同图结果并保留频次与真实上下文',
  async (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'weq-sticker-images-'));
    roots.push(root);
    mocks.card.mockResolvedValue(makeBackupPersona().profile.card);
    const ocr = vi.fn(async () => {
      if (mode === 'failed') throw new Error('合成 OCR 失败');
      return { text: mode === 'skipped' ? '' : '合成表情文字', skipped: mode === 'skipped' };
    });
    const load = vi.fn(async () => ({ dataUrl: 'data:image/png;base64,synthetic', key: 'smile' }));
    const fetch = vi.fn(async () => {
      if (mode === 'fallback') throw new Error('合成视觉失败');
      return new Response(JSON.stringify({ choices: [{ message: { content: '合成开心表情' } }] }));
    });
    vi.stubGlobal('fetch', fetch);
    let preference: AiImageMode =
      mode === 'placeholder'
        ? 'placeholder'
        : mode === 'vision' || mode === 'fallback' || mode === 'unconfigured'
          ? 'vision'
          : 'ocr';
    const images = new AiImageProcessor({
      mode: () => preference,
      vision: () =>
        mode === 'unconfigured'
          ? null
          : {
              baseUrl: 'https://fixture.invalid',
              apiKey: 'fixture',
              model: 'shared-vision',
            },
      load,
      ocr,
    });
    const file = join(root, 'synthetic.png');
    writeFileSync(file, 'synthetic image');
    const findFile = vi.fn(async () => ({ thumb: file }));
    const download = vi.fn();
    const pic = {
      kind: 'pic',
      subType: 1,
      md5: 'smile',
      fileName: 'synthetic.png',
      fileToken: 'token',
    };
    const messages = [
      { msgId: 3n, msgSeq: 3n, senderUin: 10002n, sendTime: 999003n, elements: [pic] },
      { msgId: 2n, msgSeq: 2n, senderUin: 10002n, sendTime: 999002n, elements: [pic, pic] },
      {
        msgId: 1n,
        msgSeq: 1n,
        senderUin: 10001n,
        sendTime: 999001n,
        elements: [{ kind: 'text', textContent: '合成开心话题' }],
      },
      ...Array.from({ length: (GROUP_SUPPLEMENT_THRESHOLD + 1) * 2 }, (_, index) => ({
        msgSeq: BigInt(index + 10),
        senderUin: index % 2 ? 10002n : 10001n,
        sendTime: BigInt(1000 + index * 60),
        elements: [
          {
            kind: 'text',
            textContent: index % 2 ? `合成回复内容${index}` : `合成问题内容${index}`,
          },
        ],
      })).reverse(),
    ] as unknown as C2cMsg[];
    const session = {
      context: { uin: '10001' },
      uidMap: { sortNoByUid: () => undefined },
      profileInfo: { getProfileByUin: async () => null, getProfile: async () => null },
      c2cMsgs: { listLatest: async () => messages, listBefore: async () => [] },
    } as unknown as AccountSession;
    const resolve = vi.fn<EndpointResolver>(() => ({
      baseUrl: 'https://fixture.invalid',
      apiKey: 'fixture',
      model: 'chat',
    }));
    const service = new AgentLabService(session, root, resolve, {
      images,
      fileSearch: { findFile } as unknown as AgentLabMediaDeps['fileSearch'],
      mediaDownload: { download } as unknown as AgentLabMediaDeps['mediaDownload'],
    });
    const result = await service.buildFromC2c({
      personaId: 'sticker-clone',
      targetUid: 'peer',
      mode: 'private',
      // 旧客户端保存的专用模型不能绕过当前图片偏好。
      models: {
        chat: { useDefault: true },
        vision: { providerId: 'legacy', model: 'legacy-vision' },
      },
    });
    const description =
      mode === 'vision'
        ? '合成开心表情'
        : mode === 'ocr' || mode === 'fallback' || mode === 'unconfigured'
          ? '合成表情文字'
          : '';
    expect(result.stickers).toMatchObject([
      {
        md5: 'smile',
        count: 3,
        description,
        scenario: '',
        contexts: ['合成开心话题'],
      },
    ]);
    expect(result.stickers?.[0]?.localPath).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(mode === 'vision' || mode === 'fallback' ? 1 : 0);
    expect(ocr).toHaveBeenCalledTimes(mode === 'placeholder' || mode === 'vision' ? 0 : 1);
    expect(load).toHaveBeenCalledTimes(mode === 'vision' || mode === 'fallback' ? 1 : 0);
    expect(resolve.mock.calls.every((args) => args[1] !== 'vision')).toBe(true);
    expect(download).not.toHaveBeenCalled();
    const corpus = mocks.card.mock.calls[0]?.[3];
    if (description) expect(corpus).toContain(`[图片内容]${description}`);
    expect(corpus).not.toContain('合成 OCR 失败');
    expect(corpus).not.toContain('合成视觉失败');
    if (mode === 'vision') {
      preference = 'placeholder';
      const refreshed = await service.refreshFromC2c(result.id);
      expect(refreshed.stickers?.[0]).toMatchObject({
        description: '',
        count: 3,
        contexts: ['合成开心话题'],
      });
      expect(fetch).toHaveBeenCalledOnce();
      expect(ocr).not.toHaveBeenCalled();
    }
    await service.close();
  },
);
