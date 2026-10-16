/**
 * MCP 侧的图片文字识别工具（`ocr_image_text` / `get_ocr_status`）。
 *
 * 这里盯的是**调用者能看到的那个约定**：这次识别到底走了在线接口还是本地离线模型，
 * 以及「在线优先、本地兜底」这套排腿逻辑在四种处境下的行为 —— 在线可用、在线失败、
 * 在线不可用（QQ 离线 / 物料不全）、两条腿都没有。取图与真模型都 mock 掉（真跑推理
 * 要 fork onnxruntime，那是 `ocr_pipeline.test.ts` 与真机的事）。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Record0 {
  qqOnline: boolean;
  qqPid?: number;
  guid?: string;
  session?: { a2?: string; d2?: string; d2Key?: string };
}

const mocks = vi.hoisted(() => ({
  record: null as Record0 | null,
  autoAttachQq: true,
  localModel: null as { modelId: string; paths: Record<string, string> } | null,
  /** 识别结果缓存的根目录（每个用例一个临时目录）。 */
  cacheRoot: '',
  recognize: vi.fn(),
  findFile: vi.fn(),
  runLocalOcr: vi.fn(),
  getGroupMessageById: vi.fn(),
  pic: null as unknown,
}));

vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({
    services: {
      accountConfig: { getRecord: () => mocks.record },
      msgs: { getGroupMessageById: mocks.getGroupMessageById, getC2cMessageById: vi.fn() },
      fileSearch: { findFile: mocks.findFile },
      chatImageOcr: { recognize: mocks.recognize },
    },
    bootstrap: {
      userConfig: {
        getSettings: () => ({ autoAttachQq: mocks.autoAttachQq }),
        cacheDir: (category: string) => join(mocks.cacheRoot, category),
      },
    },
  }),
}));

vi.mock('../src/main/ocr/local', () => ({
  resolveLocalOcrModel: () => mocks.localModel,
  runLocalOcr: mocks.runLocalOcr,
}));

import { AI_TOOLS } from '../src/main/mcp/tools';
import { OcrResultCache } from '@weq/service';

function tool(name: string) {
  const found = AI_TOOLS.find((t) => t.name === name);
  if (!found) throw new Error(`没有这个工具：${name}`);
  return found;
}

/** 一次 `ocr_image_text` 调用（参数不经过 zod，默认值由调用方自己给全）。 */
async function ocr(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return (await tool('ocr_image_text').run({
    engine: 'auto',
    includeBoxes: false,
    ...args,
  })) as Record<string, unknown>;
}

const ocrBlock = (text: string) => ({
  text,
  rect: { x: 1, y: 2, width: 30, height: 10 },
  quad: [],
  parag: '{"Parag":{"ParagNo":1}}',
  field2: 99,
});

const readyRecord: Record0 = {
  qqOnline: true,
  qqPid: 4321,
  guid: 'guid',
  session: { a2: 'a2', d2: 'd2', d2Key: 'd2key' },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cacheRoot = mkdtempSync(join(tmpdir(), 'weq-ocr-mcp-'));
  mocks.record = { ...readyRecord };
  mocks.autoAttachQq = true;
  mocks.localModel = null;
  mocks.pic = {
    type: 'pic',
    data: {
      fileName: 'a.jpg',
      fileToken: 'token-1',
      imgWidth: 800,
      imgHeight: 600,
      fileSize: 12345,
      subType: 0,
    },
  };
  mocks.getGroupMessageById.mockResolvedValue({ sendTime: 1_700_000_000n, elements: [mocks.pic] });
  mocks.findFile.mockResolvedValue({ source: '/tmp/pic/a.jpg', thumb: null });
  mocks.recognize.mockResolvedValue({
    status: 'succ',
    srcLang: 'zh',
    blocks: [ocrBlock('在线结果')],
    imageWidth: 800,
    imageHeight: 600,
    sessionId: 'sid',
  });
  mocks.runLocalOcr.mockResolvedValue({
    blocks: [ocrBlock('本地结果')],
    imageWidth: 800,
    imageHeight: 600,
    elapsedMs: 1234,
    modelId: 'ppocr-v5-mobile',
  });
});

afterEach(() => {
  if (mocks.cacheRoot) rmSync(mocks.cacheRoot, { recursive: true, force: true });
});

describe('ocr_image_text', () => {
  it('在线可用时走在线，并标出来', async () => {
    const out = await ocr({ kind: 'group', conv: '123', msgId: '456' });
    expect(out.ok).toBe(true);
    expect(out.source).toBe('online');
    expect(out.offline).toBe(false);
    expect(out.engine).toContain('在线接口');
    expect(out.text).toBe('在线结果');
    expect(out.srcLang).toBe('zh');
    expect(mocks.runLocalOcr).not.toHaveBeenCalled();
  });

  it('在线失败时回退本地，并说清楚为什么', async () => {
    mocks.localModel = { modelId: 'ppocr-v5-mobile', paths: {} };
    mocks.recognize.mockRejectedValue(new Error('服务端已经取不到这张图了'));
    const out = await ocr({ kind: 'group', conv: '123', msgId: '456' });
    expect(out.source).toBe('local');
    expect(out.offline).toBe(true);
    expect(out.engine).toContain('本地离线模型');
    expect(out.modelId).toBe('ppocr-v5-mobile');
    expect(out.text).toBe('本地结果');
    const notes = out.notes as string[];
    expect(notes.some((n) => n.includes('在线接口没成'))).toBe(true);
  });

  it('QQ 离线时不碰在线那条腿，notes 里给出原因', async () => {
    mocks.record = { ...readyRecord, qqOnline: false };
    mocks.localModel = { modelId: 'ppocr-v5-mobile', paths: {} };
    const out = await ocr({ kind: 'group', conv: '123', msgId: '456' });
    expect(out.source).toBe('local');
    expect(mocks.recognize).not.toHaveBeenCalled();
    expect((out.notes as string[]).some((n) => n.includes('QQ 未在线'))).toBe(true);
  });

  it('engine=local 时只走本地，哪怕在线可用', async () => {
    mocks.localModel = { modelId: 'ppocr-v5-mobile', paths: {} };
    const out = await ocr({ kind: 'group', conv: '123', msgId: '456', engine: 'local' });
    expect(out.source).toBe('local');
    expect(mocks.recognize).not.toHaveBeenCalled();
  });

  it('本机路径的图只能走本地模型', async () => {
    mocks.localModel = { modelId: 'ppocr-v5-mobile', paths: {} };
    const out = await ocr({ path: '/tmp/shot.png' });
    expect(out.source).toBe('local');
    expect(mocks.runLocalOcr).toHaveBeenCalledWith('/tmp/shot.png', mocks.localModel);
    await expect(ocr({ path: '/tmp/shot.png', engine: 'online' })).rejects.toThrow(/fileToken/);
  });

  it('两条腿都没有时返回 ok=false，而不是抛错', async () => {
    mocks.record = { ...readyRecord, qqOnline: false };
    const out = await ocr({ kind: 'group', conv: '123', msgId: '456' });
    expect(out.ok).toBe(false);
    expect(out.source).toBeNull();
    expect(out.notes).toBeTruthy();
    expect(String(out.hint)).toContain('get_ocr_status');
  });

  it('本地腿取不到图时，报的就是那条原因（不是泛泛的一句失败）', async () => {
    mocks.record = { ...readyRecord, qqOnline: false };
    mocks.localModel = { modelId: 'ppocr-v5-mobile', paths: {} };
    mocks.findFile.mockResolvedValue({ source: null, thumb: null });
    const out = await ocr({ kind: 'group', conv: '123', msgId: '456' });
    expect(out.ok).toBe(false);
    expect(String(out.error)).toContain('本机媒体缓存里没有这张图');
    expect(mocks.runLocalOcr).not.toHaveBeenCalled();
  });

  it('可以带出每段文字的像素坐标框', async () => {
    const out = await ocr({ kind: 'group', conv: '123', msgId: '456', includeBoxes: true });
    const boxes = out.boxes as Array<Record<string, unknown>>;
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({ text: '在线结果', width: 30, confidence: 99 });
  });
});

describe('get_ocr_status', () => {
  it('两条腿都可用时都说 available', async () => {
    mocks.localModel = { modelId: 'ppocr-v5-mobile', paths: {} };
    const out = (await tool('get_ocr_status').run({})) as Record<string, never>;
    expect(out.online).toEqual({ available: true });
    expect(out.local).toEqual({ available: true, modelId: 'ppocr-v5-mobile' });
  });

  it('缺料 / 缺模型时各带原因', async () => {
    mocks.record = { qqOnline: true, qqPid: 4321, guid: 'guid', session: { a2: 'a2' } };
    const out = (await tool('get_ocr_status').run({})) as Record<string, { available: boolean }>;
    expect(out.online.available).toBe(false);
    expect(out.local.available).toBe(false);
  });
});

describe('ocr_image_text + 结果缓存', () => {
  /** 把这张图的元素 md5 设成指定值 —— 缓存键就是它。 */
  function setPicMd5(md5: string): void {
    (mocks.pic as { data: Record<string, unknown> }).data.md5 = md5;
  }

  it('本机缓存里已经有这张图 → 直接给结果，两条腿都不跑', async () => {
    const md5 = 'd'.repeat(32);
    setPicMd5(md5);
    const cache = new OcrResultCache(join(mocks.cacheRoot, 'ocr'));
    await cache.putText(md5, 'oidb', {
      text: '缓存里的文字',
      blocks: [ocrBlock('缓存里的文字')],
      frame: { width: 800, height: 600, variant: 'original' },
      lang: 'zh',
    });

    const out = await ocr({ kind: 'group', conv: '123', msgId: '456' });
    expect(out).toMatchObject({
      ok: true,
      cached: true,
      source: 'online',
      text: '缓存里的文字',
      offline: false,
      lineCount: 1,
    });
    expect(String(out.engine)).toContain('本机缓存');
    expect(mocks.recognize).not.toHaveBeenCalled();
    expect(mocks.runLocalOcr).not.toHaveBeenCalled();
  });

  it('本地模型跑完写进缓存：下一次调用直接命中，不再动模型', async () => {
    const md5 = 'e'.repeat(32);
    setPicMd5(md5);
    mocks.record = { ...readyRecord, qqOnline: false };
    mocks.localModel = { modelId: 'ppocr-v5-mobile', paths: {} };

    const first = await ocr({ kind: 'group', conv: '123', msgId: '456' });
    expect(first).toMatchObject({ ok: true, source: 'local', text: '本地结果' });
    expect(first.cached).toBeUndefined();

    const second = await ocr({ kind: 'group', conv: '123', msgId: '456' });
    expect(second).toMatchObject({ ok: true, cached: true, source: 'local', text: '本地结果' });
    expect(mocks.runLocalOcr).toHaveBeenCalledTimes(1);
  });

  it('engine 明确要某一腿时不拿另一条腿的缓存顶替', async () => {
    const md5 = 'f'.repeat(32);
    setPicMd5(md5);
    const cache = new OcrResultCache(join(mocks.cacheRoot, 'ocr'));
    await cache.putText(md5, 'local:ppocr-v5-mobile', {
      text: '只有本地的那份',
      frame: { width: 800, height: 600, variant: 'original' },
      modelId: 'ppocr-v5-mobile',
    });

    // 明确要在线：本地缓存不作数，照走在线
    const out = await ocr({ kind: 'group', conv: '123', msgId: '456', engine: 'online' });
    expect(out).toMatchObject({ source: 'online', text: '在线结果' });
    expect(out.cached).toBeUndefined();
    expect(mocks.recognize).toHaveBeenCalledTimes(1);
  });
});
