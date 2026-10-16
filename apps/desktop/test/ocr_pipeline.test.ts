/**
 * 本地 OCR 管线的单测（`src/main/ocr/pipeline.ts`）。
 *
 * 这里**不碰 onnxruntime、也不碰真模型**：会话是假的（按需吐一张造出来的概率图 /
 * 假 logits），验的是「搬过来的那套后处理」有没有搬对 —— 二值化 / 连通域 / 最小外接
 * 矩形 / unclip 外扩 / 坐标缩放、CTC 贪心解码、透视裁切、段落分组。这些地方错一步
 * 都是「框整体偏一格」或「文字串行」这种肉眼很难一眼看出来的毛病。
 */

import { describe, expect, it } from 'vitest';
import {
  assignParagraphs,
  ctcDecode,
  detect,
  parseDict,
  runOcrPipeline,
  sortBoxes,
  type OcrSession,
  type OcrPoint,
  type RgbImage,
} from '../src/main/ocr/pipeline';

/** 造一张纯色图（默认全黑，方便用像素值反推裁切有没有对）。 */
function solidImage(width: number, height: number, rgb: [number, number, number] = [0, 0, 0]) {
  const data = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 3] = rgb[0];
    data[i * 3 + 1] = rgb[1];
    data[i * 3 + 2] = rgb[2];
  }
  return { width, height, data } satisfies RgbImage;
}

/** 一张「左下角亮、其余黑」的图 —— 透视裁切时用它能直接看出裁的是不是那一块。 */
function quadrantImage(width: number, height: number): RgbImage {
  const img = solidImage(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const bright = x < width / 2 && y >= height / 2;
      const v = bright ? 255 : 0;
      const base = (y * width + x) * 3;
      img.data[base] = v;
      img.data[base + 1] = v;
      img.data[base + 2] = v;
    }
  }
  return img;
}

/** 一张按比例尺缩放后的假会话：把「原图坐标」上的矩形映射到它收到的尺寸上。 */
function fakeDetector(rect: { x: number; y: number; width: number; height: number }): OcrSession {
  return {
    async run(data, dims) {
      const height = dims[2]!;
      const width = dims[3]!;
      // 输入张量是 NCHW，用它的尺寸反推缩放比（管线只喂过一张图，尺寸一一对应）。
      const scaleX = width / 1917;
      const scaleY = height / 837;
      const out = new Float32Array(width * height);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const inside =
            x >= rect.x * scaleX &&
            x < (rect.x + rect.width) * scaleX &&
            y >= rect.y * scaleY &&
            y < (rect.y + rect.height) * scaleY;
          out[y * width + x] = inside ? 0.95 : 0.01;
        }
      }
      expect(data.length).toBe(3 * width * height);
      return { data: out, dims: [1, 1, height, width] };
    },
  };
}

describe('CTC 解码', () => {
  /** 造一张 one-hot logits：`steps` 里每个数字是「该时间步最大概率的类别」。 */
  function logits(steps: number[], classes = 5): Float32Array {
    const data = new Float32Array(steps.length * classes);
    steps.forEach((cls, t) => {
      for (let c = 0; c < classes; c += 1) data[t * classes + c] = c === cls ? 0.9 : 0.01;
    });
    return data;
  }

  const dict = ['你', '好', '世', '界'];

  it('丢掉 blank、合并连续重复，并按 0=blank / 1..n=字典 / n+1=空格 映射', () => {
    // 0=blank 1=你 2=好 5=空格（dict 4 项 ⇒ 空格 = 5）
    const { text, score } = ctcDecode(logits([1, 1, 0, 2, 5, 2, 0], 6), 7, 6, dict);
    expect(text).toBe('你好 好');
    expect(score).toBeCloseTo(0.9, 5);
  });

  it('全程 blank 时输出空串、分数 0', () => {
    expect(ctcDecode(logits([0, 0, 0], 6), 3, 6, dict)).toEqual({ text: '', score: 0 });
  });
});

describe('字典解析', () => {
  it('去掉结尾空行与 CRLF 的 \\r', () => {
    expect(parseDict('a\r\nb\nc\n')).toEqual(['a', 'b', 'c']);
    expect(parseDict('a\nb')).toEqual(['a', 'b']);
  });
});

describe('阅读顺序与段落', () => {
  const line = (x: number, y: number, width = 40, height = 10) => ({
    quad: [],
    rect: { x, y, width, height },
    score: 0.9,
  });

  it('先上→下、同一行内左→右', () => {
    const sorted = sortBoxes([line(100, 5), line(10, 50), line(20, 6)]);
    expect(sorted.map((b) => b.rect.x)).toEqual([20, 100, 10]);
  });

  it('行距明显变大才算新段落', () => {
    // 前两行紧挨着（y=0, 12），第三行隔了 40px 的空白 → 第 2 段。
    const paragraphs = assignParagraphs([line(0, 0), line(0, 12), line(0, 62), line(0, 74)]);
    expect(paragraphs).toEqual([1, 1, 2, 2]);
  });
});

describe('检测后处理', () => {
  // 一张 1917×837 的图（与真实截图同尺寸），真框放在 (400,200)-(1100,240)。
  const image = solidImage(1917, 837);
  const truth = { x: 400, y: 200, width: 700, height: 40 };

  it('概率图上的矩形 → 一个框，位置 / 尺寸对得上（含 unclip 外扩与坐标缩放）', async () => {
    const boxes = await detect(image, fakeDetector(truth));
    expect(boxes).toHaveLength(1);
    const rect = boxes[0]!.rect;
    // 框心必须对得上（±4 px：resize 到 32 的倍数 + round 的漂移）。
    expect(Math.abs(rect.x + rect.width / 2 - (truth.x + truth.width / 2))).toBeLessThanOrEqual(4);
    expect(Math.abs(rect.y + rect.height / 2 - (truth.y + truth.height / 2))).toBeLessThanOrEqual(
      4,
    );
    // 尺寸只校验量级：这里喂进去的概率图**没有**复现 DB 训练时的收缩，所以 unclip 外扩
    // 是「净增」的（真实概率图本身是收缩过的细带，外扩正好补回来，不会这么肥）。
    expect(rect.width).toBeGreaterThan(truth.width * 0.9);
    expect(rect.width).toBeLessThan(truth.width * 1.2);
    expect(rect.height).toBeGreaterThan(0);
    expect(boxes[0]!.quad).toHaveLength(4);
  });

  it('置信度低于下限的连通域会被丢掉（噪声不会变成框）', async () => {
    const noisy: OcrSession = {
      async run(_data, dims) {
        const height = dims[2]!;
        const width = dims[3]!;
        const out = new Float32Array(width * height).fill(0.35);
        return { data: out, dims: [1, 1, height, width] };
      },
    };
    // 0.35 过了二值化阈值（0.3）但没过框置信度（0.5）→ 一个框都不该剩。
    expect(await detect(image, noisy)).toEqual([]);
  });
});

describe('整条管线', () => {
  it('det + rec（假会话）出文字；只给 det 时只出框', async () => {
    const image = quadrantImage(1917, 837);
    const det = fakeDetector({ x: 400, y: 200, width: 700, height: 40 });
    // 假的识别会话：每个时间步都在「好」上取最大（dict 下标 1 → 类别 2），输出 4 段。
    const rec: OcrSession = {
      async run(_data, dims) {
        const width = dims[3]!;
        const timeSteps = Math.ceil(width / 8);
        const classes = 4;
        const out = new Float32Array(timeSteps * classes);
        for (let t = 0; t < timeSteps; t += 1) out[t * classes + 2] = 0.8;
        return { data: out, dims: [1, timeSteps, classes] };
      },
    };

    const onlyDet = await runOcrPipeline(image, { det });
    expect(onlyDet).toHaveLength(1);
    expect(onlyDet[0]!.text).toBe('');

    const withText = await runOcrPipeline(image, { det, rec, dict: ['你', '好', '世'] });
    expect(withText).toHaveLength(1);
    expect(withText[0]!.text).toBe('好');
    expect(withText[0]!.textScore).toBeCloseTo(0.8, 5);
  });
});

describe('方向分类', () => {
  it('够确信「倒了」才转 180°（裁剪宽度不变，但框顺序反过来）', async () => {
    const image = quadrantImage(400, 200);
    const det = fakeDetector({ x: 40, y: 40, width: 300, height: 60 });
    // 分类会话恒答「倒了」（第 1 类 0.99）。
    const upsidedown: OcrSession = {
      async run(_data, dims) {
        const out = new Float32Array([0.01, 0.99]);
        expect(dims).toEqual([1, 3, 80, 160]);
        return { data: out, dims: [1, 2] };
      },
    };
    /** 记录收到的裁剪首像素，用来判断喂进来的到底是不是「转过的」那一版。 */
    let firstPixel = -1;
    const rec: OcrSession = {
      async run(data, dims) {
        firstPixel = data[0]!;
        const width = dims[3]!;
        return { data: new Float32Array(Math.ceil(width / 8) * 3), dims: [1, width / 8, 3] };
      },
    };

    await runOcrPipeline(image, { det, rec, dict: ['a'], cls: upsidedown });
    // 左下角是亮的（quadrantImage 的定义）：转 180° 后，裁剪的左上角应该落在原图
    // 右下角 —— 那一块是黑的，所以首像素归一化后是 -1。
    expect(firstPixel).toBeCloseTo(-1, 3);
  });
});

describe('透视裁切', () => {
  it('轴对齐的框直接裁原像素；倾斜的框按角点采样', async () => {
    const image = quadrantImage(200, 100);
    const samples: Float32Array[] = [];
    const rec: OcrSession = {
      async run(data, dims) {
        samples.push(data);
        const width = dims[3]!;
        const timeSteps = Math.ceil(width / 8);
        return { data: new Float32Array(timeSteps * 3), dims: [1, timeSteps, 3] };
      },
    };
    const det: OcrSession = {
      async run(_data, dims) {
        const height = dims[2]!;
        const width = dims[3]!;
        const map = new Float32Array(width * height);
        // 只在左上那半张图上点亮一块 → 出来的框落在亮暗交界附近。
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            const inside = x > 0.1 * width && x < 0.3 * width;
            map[y * width + x] = inside ? 0.9 : 0.01;
          }
        }
        return { data: map, dims: [1, 1, height, width] };
      },
    };

    await runOcrPipeline(image, { det, rec, dict: ['a'] });
    expect(samples).toHaveLength(1);
    // 左上角是黑的（quadrantImage 的亮块在左下）→ NCHW 第一个值 ≈ (0/255-0.5)/0.5 = -1。
    expect(samples[0]![0]!).toBeCloseTo(-1, 2);
  });

  it('退化四边形不会算出 NaN', async () => {
    const image = solidImage(64, 64, [128, 128, 128]);
    let seen = 0;
    const det: OcrSession = {
      async run(_data, dims) {
        const height = dims[2]!;
        const width = dims[3]!;
        const map = new Float32Array(width * height).fill(0.9);
        return { data: map, dims: [1, 1, height, width] };
      },
    };
    const rec: OcrSession = {
      async run(data) {
        seen += 1;
        expect(data.every((v) => Number.isFinite(v))).toBe(true);
        return { data: new Float32Array(3), dims: [1, 1, 3] };
      },
    };
    const lines = await runOcrPipeline(image, { det, rec, dict: ['a'] });
    expect(lines.length).toBeGreaterThan(0);
    expect(seen).toBe(lines.length);
  });
});

describe('超长行分段', () => {
  it('宽度超过上限时切成多段识别，结果接起来（不崩、不丢字符）', async () => {
    const image = solidImage(2000, 200);
    const det: OcrSession = {
      async run(_data, dims) {
        const height = dims[2]!;
        const width = dims[3]!;
        const map = new Float32Array(width * height);
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            // 一整条横带：高度 10% ≈ 原图 20px，宽 ≈ 原图 2000px ⇒ 长宽比 100。
            map[y * width + x] = y > 0.4 * height && y < 0.5 * height ? 0.9 : 0.01;
          }
        }
        return { data: map, dims: [1, 1, height, width] };
      },
    };
    let runs = 0;
    const rec: OcrSession = {
      async run(_data, dims) {
        runs += 1;
        const width = dims[3]!;
        expect(width).toBeLessThanOrEqual(1600);
        const timeSteps = Math.ceil(width / 8);
        const classes = 3;
        const out = new Float32Array(timeSteps * classes);
        for (let t = 0; t < timeSteps; t += 1) out[t * classes + 1] = 0.9;
        return { data: out, dims: [1, timeSteps, classes] };
      },
    };
    const lines = await runOcrPipeline(image, { det, rec, dict: ['x', 'y'] });
    expect(lines).toHaveLength(1);
    expect(runs).toBeGreaterThan(1);
    // 假的识别会话恒答「类别 1」＝字典第 0 项，于是每段都吐 'x'，接起来是 runs 个。
    expect(lines[0]!.text).toBe('x'.repeat(runs));
  });
});

describe('角点工具', () => {
  it('4 角点的顺序是左上 → 右上 → 右下 → 左下（供覆盖层直接用）', async () => {
    const image = solidImage(1917, 837);
    const boxes = await detect(image, fakeDetector({ x: 400, y: 200, width: 700, height: 40 }));
    const quad = boxes[0]!.quad as OcrPoint[];
    expect(quad[0]!.x).toBeLessThan(quad[1]!.x);
    expect(quad[0]!.y).toBeLessThan(quad[3]!.y);
    expect(quad[2]!.x).toBeGreaterThan(quad[3]!.x);
  });
});
