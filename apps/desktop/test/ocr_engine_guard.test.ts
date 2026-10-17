/**
 * 本地 OCR 引擎的平台闸（`src/main/ocr/engine.ts`）。
 *
 * 起因是个真踩过的坑：`onnxruntime-node` 不发 macOS Intel（darwin/x64）的二进制，
 * 而 Intel Mac 上照样能进设置页把 21 MB 的模型下完，然后每次识别都撞一句
 * MODULE_NOT_FOUND —— 用户完全看不出「这台机器压根没有引擎」。
 *
 * 现在 `localOcrBlocker()` 是唯一的事实源（`main/ocr/local.ts` 拿它当前置闸，
 * engine 这里是最后一层）：跑不起来就别 fork，把原因原样带给调用方。
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@weq/service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weq/service')>()),
  localOcrBlocker: () => '当前平台（macOS Intel）没有本地识别引擎：……（在线识别不受影响）。',
}));

import { runOcrEngine } from '../src/main/ocr/engine';

/** 一张 2×2 的裸 RGB 图（引擎只看尺寸，不碰像素内容）。 */
const image = { width: 2, height: 2, data: new Uint8Array(12) };

describe('runOcrEngine 平台闸', () => {
  it('本机没有推理引擎时不 fork，直接把原因作为 error 返回', async () => {
    const result = await runOcrEngine({ image, paths: { det: '/tmp/does-not-exist.onnx' } });

    expect(result.ok).toBe(false);
    expect(result.blocks).toEqual([]);
    expect(result.error).toContain('macOS Intel');
    // 尺寸照实回，调用方（灯箱覆盖层）不用为失败路径开特例。
    expect(result.imageWidth).toBe(2);
    expect(result.imageHeight).toBe(2);
  });
});
