/**
 * PP-OCR 推理管线 —— 检测（DBNet）+ 方向分类 + 识别（CRNN/SVTR），纯 TypeScript。
 *
 * 布局照 PaddleOCR / RapidOCR 的推理实现搬：
 *
 *   det  resize 到 32 的倍数（最长边 ≤ `limitSide`）→ 概率图 → 二值化 → 8 邻域连通域
 *        → 框置信度过滤 → unclip 外扩 → 最小外接矩形（4 角点）
 *   cls  文字行 180° 方向分类（PP-LCNet x0.25，输入 3×80×160）
 *   rec  按 4 角点透视裁切 → 高度归一 48 → CTC 贪心解码（对字典）
 *
 * 这里**不 import onnxruntime**：会话以 {@link OcrSession} 的最小接口注入，管线本身
 * 是纯几何 + 数值代码，单测里用假会话就能跑（真会话在 `worker.ts` 里包一层）。
 *
 * 坐标全程是**原图像素坐标**（原点左上），与在线那条线（`@weq/protocol` 的
 * `OcrImage`）同口径 —— 产出的 `quad` / `rect` 可以直接喂给现成的灯箱覆盖层与
 * `OcrTextPanel`。
 *
 * 模型细节（实测，2026-10-16，`ppocr-v5-mobile`）：
 *   det  in `x` [1,3,H,W]（H/W 是 32 的倍数）→ out [1,1,H,W] 概率图，与输入同尺寸；
 *   cls  in `x` [1,3,80,160] → out [1,2]，**已经是 softmax 后的概率**（和恒为 1）；
 *   rec  in `x` [1,3,48,W]（W 动态）→ out [1,T,C]，T = W/8；`ppocrv5_dict.txt` 是
 *        18383 行，C = 18385 = 1(blank) + 18383(字典) + 1(空格)，与 PaddleOCR 的
 *        `CTCLabelDecode`（`['blank'] + dict + [' ']`）对得上。
 */

/** 裸 RGB 位图：每像素 3 字节，行优先。 */
export interface RgbImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface OcrPoint {
  x: number;
  y: number;
}

export interface OcrRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 一个检测框：4 角点（左上 → 右上 → 右下 → 左下绕一圈）+ 外接矩形 + 框置信度。 */
export interface DetBox {
  quad: OcrPoint[];
  rect: OcrRect;
  /** 框内像素的平均概率（0-1）。 */
  score: number;
}

/** 一行识别结果。 */
export interface TextLine extends DetBox {
  text: string;
  /** 识别置信度（0-1）；只要检测没有识别时是 0。 */
  textScore: number;
}

/**
 * onnxruntime 会话的最小抽象：喂一个 NCHW float32 张量，拿第一个输出。
 *  purposely 不含任何 ORT 类型，方便单测注入假会话。
 */
export interface OcrSession {
  run(
    data: Float32Array,
    dims: readonly number[],
  ): Promise<{ data: Float32Array; dims: readonly number[] }>;
}

// ─────────────────────────── 超参 ───────────────────────────

export interface DetOptions {
  /** 缩放后最长边上限（limit_type = max），也是 det 的推理分辨率。 */
  limitSide: number;
  /** 概率图二值化阈值。 */
  thresh: number;
  /** 框置信度下限。 */
  boxThresh: number;
  /** unclip 外扩比例（DB 训练时按此比例收缩了文字区域，推理时反向补回来）。 */
  unclipRatio: number;
  /** 单图最多保留多少个框（防御性上限）。 */
  maxCandidates: number;
  /** 框的最小边（概率图像素）：比这更细的连通域当噪声丢掉。 */
  minSize: number;
}

export const DET_DEFAULTS: DetOptions = {
  limitSide: 960,
  thresh: 0.3,
  boxThresh: 0.5,
  unclipRatio: 1.5,
  maxCandidates: 1000,
  minSize: 3,
};

/** 识别输入的高度（PP-OCR 的 `rec_image_shape: [3, 48, W]`）。 */
export const REC_IMAGE_HEIGHT = 48;
/** 识别输入的最小宽度（= 48 × 320/48，与配置里的 320 对齐）。 */
export const REC_MIN_WIDTH = 320;
/**
 * 识别输入的最大宽度：更长的行拆成多段分别识别、结果接起来。
 * 320 是训练时的宽度；超长行继续加宽会掉进分布外（CTC 会吐重复字），
 * 拆段比硬喂更稳。取 1600 ⇒ 单段最多 200 个时间步、约 8 倍超采样。
 */
export const REC_MAX_WIDTH = 1600;

/** 方向分类输入尺寸（PP-LCNet x0.25 textline_ori）。 */
export const CLS_IMAGE_WIDTH = 160;
export const CLS_IMAGE_HEIGHT = 80;
/** 方向分类的翻转阈值：只有它足够确信「倒了」才真的转 180°。 */
export const CLS_THRESHOLD = 0.9;

/** 单图最多识别多少行（防御性上限，避免一张噪声图跑爆 CPU）。 */
const MAX_LINES = 400;

// ─────────────────────────── 图像基元 ───────────────────────────

/** 双线性采样一个像素，写进 `out[base..base+2]`（值域 0-255）。 */
function sampleBilinear(
  img: RgbImage,
  x: number,
  y: number,
  out: Float32Array,
  base: number,
): void {
  const cx = x < 0 ? 0 : x > img.width - 1 ? img.width - 1 : x;
  const cy = y < 0 ? 0 : y > img.height - 1 ? img.height - 1 : y;
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = x0 + 1 > img.width - 1 ? img.width - 1 : x0 + 1;
  const y1 = y0 + 1 > img.height - 1 ? img.height - 1 : y0 + 1;
  const fx = cx - x0;
  const fy = cy - y0;
  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;
  const i00 = (y0 * img.width + x0) * 3;
  const i10 = (y0 * img.width + x1) * 3;
  const i01 = (y1 * img.width + x0) * 3;
  const i11 = (y1 * img.width + x1) * 3;
  const d = img.data;
  for (let c = 0; c < 3; c += 1) {
    out[base + c] = d[i00 + c]! * w00 + d[i10 + c]! * w10 + d[i01 + c]! * w01 + d[i11 + c]! * w11;
  }
}

/**
 * 解 8×8 线性方程组 `A x = b`（高斯消元 + 部分主元）。
 * 用于解透视变换：把「目标矩形」映射回「源四边形」的逆单应矩阵。
 */
function solve8(a: number[][], b: number[]): number[] | null {
  for (let col = 0; col < 8; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < 8; row += 1) {
      if (Math.abs(a[row]![col]!) > Math.abs(a[pivot]![col]!)) pivot = row;
    }
    if (Math.abs(a[pivot]![col]!) < 1e-12) return null;
    if (pivot !== col) {
      const t = a[pivot]!;
      a[pivot] = a[col]!;
      a[col] = t;
      const tb = b[pivot]!;
      b[pivot] = b[col]!;
      b[col] = tb;
    }
    const p = a[col]![col]!;
    for (let row = col + 1; row < 8; row += 1) {
      const f = a[row]![col]! / p;
      if (f === 0) continue;
      for (let k = col; k < 8; k += 1) a[row]![k] = a[row]![k]! - f * a[col]![k]!;
      b[row] = b[row]! - f * b[col]!;
    }
  }
  const x = new Array<number>(8).fill(0);
  for (let row = 7; row >= 0; row -= 1) {
    let sum = b[row]!;
    for (let col = row + 1; col < 8; col += 1) sum -= a[row]![col]! * x[col]!;
    x[row] = sum / a[row]![row]!;
  }
  return x;
}

// ─────────────────────────── det ───────────────────────────

/** 概率图上的一个连通域（后续要算最小外接矩形）。 */
interface Component {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  count: number;
  probSum: number;
  /** 该连通域的像素坐标，`[x0,y0,x1,y1,…]`（BFS 时收集，供最小外接矩形用）。 */
  points: Int32Array;
}

function resizeForDet(img: RgbImage, limitSide: number): { width: number; height: number } {
  const maxSide = Math.max(img.width, img.height);
  const ratio = limitSide > 0 && maxSide > limitSide ? limitSide / maxSide : 1;
  const width = Math.max(32, Math.round((img.width * ratio) / 32) * 32);
  const height = Math.max(32, Math.round((img.height * ratio) / 32) * 32);
  return { width, height };
}

/** 图像 → det 的 NCHW 输入：ImageNet 均值方差归一化。 */
function detInput(img: RgbImage, netW: number, netH: number): Float32Array {
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  const out = new Float32Array(3 * netH * netW);
  const plane = netH * netW;
  const scaleX = img.width / netW;
  const scaleY = img.height / netH;
  const px = new Float32Array(3);
  for (let y = 0; y < netH; y += 1) {
    const sy = (y + 0.5) * scaleY - 0.5;
    for (let x = 0; x < netW; x += 1) {
      const sx = (x + 0.5) * scaleX - 0.5;
      sampleBilinear(img, sx, sy, px, 0);
      const dst = y * netW + x;
      for (let c = 0; c < 3; c += 1) {
        out[c * plane + dst] = (px[c]! / 255 - mean[c]!) / std[c]!;
      }
    }
  }
  return out;
}

/** 概率图 → 连通域（8 邻域）。 */
function connectedComponents(
  mask: Uint8Array,
  prob: Float32Array,
  width: number,
  height: number,
): Component[] {
  const visited = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  const out: Component[] = [];
  const scratch: number[] = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] === 0 || visited[start] === 1) continue;
    let top = 0;
    stack[top++] = start;
    visited[start] = 1;
    scratch.length = 0;
    let x0 = width;
    let y0 = height;
    let x1 = -1;
    let y1 = -1;
    let probSum = 0;
    while (top > 0) {
      const idx = stack[--top]!;
      const x = idx % width;
      const y = (idx - x) / width;
      scratch.push(x, y);
      probSum += prob[idx]!;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const nIdx = ny * width + nx;
          if (mask[nIdx] === 0 || visited[nIdx] === 1) continue;
          visited[nIdx] = 1;
          stack[top++] = nIdx;
        }
      }
    }
    out.push({
      x0,
      y0,
      x1,
      y1,
      count: scratch.length >> 1,
      probSum,
      points: Int32Array.from(scratch),
    });
  }
  return out;
}

/** 凸包（Andrew monotone chain）；输入是 `[x0,y0,x1,y1,…]` 的扁平数组。 */
function convexHull(points: Int32Array): number[] {
  const n = points.length >> 1;
  const idx = new Array<number>(n);
  for (let i = 0; i < n; i += 1) idx[i] = i;
  idx.sort((a, b) => {
    const ax = points[a * 2]!;
    const bx = points[b * 2]!;
    return ax === bx ? points[a * 2 + 1]! - points[b * 2 + 1]! : ax - bx;
  });
  const cross = (o: number, a: number, b: number): number =>
    (points[a * 2]! - points[o * 2]!) * (points[b * 2 + 1]! - points[o * 2 + 1]!) -
    (points[a * 2 + 1]! - points[o * 2 + 1]!) * (points[b * 2]! - points[o * 2]!);
  const hull: number[] = [];
  for (const i of idx) {
    while (hull.length >= 2 && cross(hull[hull.length - 2]!, hull[hull.length - 1]!, i) <= 0) {
      hull.pop();
    }
    hull.push(i);
  }
  const lower = hull.length + 1;
  for (let k = idx.length - 2; k >= 0; k -= 1) {
    const i = idx[k]!;
    while (hull.length >= lower && cross(hull[hull.length - 2]!, hull[hull.length - 1]!, i) <= 0) {
      hull.pop();
    }
    hull.push(i);
  }
  hull.pop();
  return hull;
}

interface MiniBox {
  /** 4 角点：左上 → 右上 → 右下 → 左下。 */
  corners: OcrPoint[];
  width: number;
  height: number;
}

/** 点集 → 最小外接矩形（旋转卡壳）。 */
function minAreaRect(points: Int32Array): MiniBox {
  const hull = convexHull(points);
  if (hull.length < 2) {
    const x = points[0]!;
    const y = points[1]!;
    return {
      corners: [
        { x, y },
        { x, y },
        { x, y },
        { x, y },
      ],
      width: 0,
      height: 0,
    };
  }
  let best = {
    area: Number.POSITIVE_INFINITY,
    cx: 0,
    cy: 0,
    w: 0,
    h: 0,
    ux: 1,
    uy: 0,
  };
  for (let i = 0; i < hull.length; i += 1) {
    const a = hull[i]!;
    const b = hull[(i + 1) % hull.length]!;
    const ex = points[b * 2]! - points[a * 2]!;
    const ey = points[b * 2 + 1]! - points[a * 2 + 1]!;
    const len = Math.hypot(ex, ey);
    if (len === 0) continue;
    const ux = ex / len;
    const uy = ey / len;
    let minP = Number.POSITIVE_INFINITY;
    let maxP = Number.NEGATIVE_INFINITY;
    let minQ = Number.POSITIVE_INFINITY;
    let maxQ = Number.NEGATIVE_INFINITY;
    for (const p of hull) {
      const x = points[p * 2]!;
      const y = points[p * 2 + 1]!;
      const proj = x * ux + y * uy;
      const orth = -x * uy + y * ux;
      if (proj < minP) minP = proj;
      if (proj > maxP) maxP = proj;
      if (orth < minQ) minQ = orth;
      if (orth > maxQ) maxQ = orth;
    }
    const area = (maxP - minP) * (maxQ - minQ);
    if (area < best.area) {
      const cp = (minP + maxP) / 2;
      const cq = (minQ + maxQ) / 2;
      best = {
        area,
        cx: cp * ux - cq * uy,
        cy: cp * uy + cq * ux,
        w: maxP - minP,
        h: maxQ - minQ,
        ux,
        uy,
      };
    }
  }
  const { cx, cy, w, h, ux, uy } = best;
  const vx = -uy;
  const vy = ux;
  const hw = w / 2;
  const hh = h / 2;
  const raw = [
    { x: cx - hw * ux - hh * vx, y: cy - hw * uy - hh * vy },
    { x: cx + hw * ux - hh * vx, y: cy + hw * uy - hh * vy },
    { x: cx + hw * ux + hh * vx, y: cy + hw * uy + hh * vy },
    { x: cx - hw * ux + hh * vx, y: cy - hw * uy + hh * vy },
  ];
  // 与 PaddleOCR 的 get_mini_boxes 一致：按 x 分成左右两组，各取 y 小的当上边 → 左上起顺时针。
  const byX = raw.slice().sort((p, q) => p.x - q.x);
  const left = byX[0]!.y <= byX[1]!.y ? [byX[0]!, byX[1]!] : [byX[1]!, byX[0]!];
  const right = byX[2]!.y <= byX[3]!.y ? [byX[2]!, byX[3]!] : [byX[3]!, byX[2]!];
  return { corners: [left[0]!, right[0]!, right[1]!, left[1]!], width: w, height: h };
}

/** 缩放 4 角点并夹到图像范围内，同时给出外接矩形。 */
function scaleQuad(
  corners: readonly OcrPoint[],
  scaleX: number,
  scaleY: number,
  imgW: number,
  imgH: number,
): { quad: OcrPoint[]; rect: OcrRect } {
  const quad = corners.map((p) => ({
    x: Math.min(imgW, Math.max(0, Math.round(p.x * scaleX))),
    y: Math.min(imgH, Math.max(0, Math.round(p.y * scaleY))),
  }));
  const xs = quad.map((p) => p.x);
  const ys = quad.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { quad, rect: { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y } };
}

/**
 * DBNet 检测：出所有文字框（原图像素坐标）。
 * 传 `session` 为 det 会话，返回按「上→下、左→右」排好序的框。
 */
export async function detect(
  img: RgbImage,
  session: OcrSession,
  options: Partial<DetOptions> = {},
): Promise<DetBox[]> {
  const opt: DetOptions = { ...DET_DEFAULTS, ...options };
  const net = resizeForDet(img, opt.limitSide);
  const { data, dims } = await session.run(detInput(img, net.width, net.height), [
    1,
    3,
    net.height,
    net.width,
  ]);
  const mapH = dims[dims.length - 2] ?? net.height;
  const mapW = dims[dims.length - 1] ?? net.width;
  const mask = new Uint8Array(mapW * mapH);
  for (let i = 0; i < mask.length; i += 1) mask[i] = data[i]! > opt.thresh ? 1 : 0;

  const scaleX = img.width / mapW;
  const scaleY = img.height / mapH;
  const boxes: DetBox[] = [];
  for (const comp of connectedComponents(mask, data, mapW, mapH)) {
    if (boxes.length >= opt.maxCandidates) break;
    if (comp.x1 - comp.x0 + 1 < opt.minSize || comp.y1 - comp.y0 + 1 < opt.minSize) continue;
    const score = comp.probSum / comp.count;
    if (score < opt.boxThresh) continue;
    const mini = minAreaRect(comp.points);
    // unclip：DB 训练时把文字区域按 area*ratio/perimeter 收缩过，这里反向外扩。
    const expand =
      mini.width + mini.height > 0
        ? (mini.width * mini.height * opt.unclipRatio) / (2 * (mini.width + mini.height))
        : 0;
    const cx = (mini.corners[0]!.x + mini.corners[2]!.x) / 2;
    const cy = (mini.corners[0]!.y + mini.corners[2]!.y) / 2;
    const grown = mini.corners.map((p) => ({
      x: cx + Math.sign(p.x - cx) * expand + (p.x - cx),
      y: cy + Math.sign(p.y - cy) * expand + (p.y - cy),
    }));
    const { quad, rect } = scaleQuad(grown, scaleX, scaleY, img.width, img.height);
    if (rect.width < 2 || rect.height < 2) continue;
    boxes.push({ quad, rect, score });
  }
  return sortBoxes(boxes);
}

/** 阅读顺序：先上→下，同一行内左→右（行高的一半当「同一行」的容差）。 */
export function sortBoxes(boxes: readonly DetBox[]): DetBox[] {
  return boxes.slice().sort((a, b) => {
    const tol = Math.min(a.rect.height, b.rect.height) * 0.5;
    const dy = a.rect.y - b.rect.y;
    return Math.abs(dy) > tol ? dy : a.rect.x - b.rect.x;
  });
}

// ─────────────────────────── 透视裁切 ───────────────────────────

/** 把四边形透视变换成 `dstW × dstH` 的 RGB 裁剪（双线性，值域 0-255）。 */
function warpQuad(
  img: RgbImage,
  quad: readonly OcrPoint[],
  dstW: number,
  dstH: number,
): Float32Array {
  const out = new Float32Array(dstW * dstH * 3);
  const [p0, p1, p2, p3] = quad as [OcrPoint, OcrPoint, OcrPoint, OcrPoint];
  // 解「目标矩形 → 源四边形」的逆单应矩阵：h = [a b c d e f g i]，u = (ax+by+c)/(gx+iy+1)。
  const a: number[][] = [];
  const b: number[] = [];
  const dst = [
    { x: 0, y: 0 },
    { x: dstW - 1, y: 0 },
    { x: dstW - 1, y: dstH - 1 },
    { x: 0, y: dstH - 1 },
  ];
  const src = [p0, p1, p2, p3];
  for (let i = 0; i < 4; i += 1) {
    const { x: X, y: Y } = dst[i]!;
    const { x: u, y: v } = src[i]!;
    a.push([X, Y, 1, 0, 0, 0, -u * X, -u * Y]);
    b.push(u);
    a.push([0, 0, 0, X, Y, 1, -v * X, -v * Y]);
    b.push(v);
  }
  const h = solve8(a, b);
  if (!h) {
    // 退化四边形（面积为 0）：退化成中心像素，别让调用方拿到 NaN。
    const px = new Float32Array(3);
    sampleBilinear(img, p0.x, p0.y, px, 0);
    for (let i = 0; i < dstW * dstH; i += 1) {
      out[i * 3] = px[0]!;
      out[i * 3 + 1] = px[1]!;
      out[i * 3 + 2] = px[2]!;
    }
    return out;
  }
  const px = new Float32Array(3);
  for (let y = 0; y < dstH; y += 1) {
    const Y = y + 0.5;
    for (let x = 0; x < dstW; x += 1) {
      const X = x + 0.5;
      const den = h[6]! * X + h[7]! * Y + 1;
      const u = (h[0]! * X + h[1]! * Y + h[2]!) / den;
      const v = (h[3]! * X + h[4]! * Y + h[5]!) / den;
      sampleBilinear(img, u - 0.5, v - 0.5, px, 0);
      const base = (y * dstW + x) * 3;
      out[base] = px[0]!;
      out[base + 1] = px[1]!;
      out[base + 2] = px[2]!;
    }
  }
  return out;
}

/** 四边形在源图上的「展开尺寸」：宽取上下边的长边，高取左右边的长边。 */
function quadSize(quad: readonly OcrPoint[]): { width: number; height: number } {
  const [p0, p1, p2, p3] = quad as [OcrPoint, OcrPoint, OcrPoint, OcrPoint];
  const dist = (a: OcrPoint, b: OcrPoint): number => Math.hypot(a.x - b.x, a.y - b.y);
  return {
    width: Math.max(dist(p0, p1), dist(p2, p3)),
    height: Math.max(dist(p0, p3), dist(p1, p2)),
  };
}

/** 沿长边把四边形切成 `[from, to]`（0-1 比例）那一段 —— 超长行的分段识别用。 */
function sliceQuad(quad: readonly OcrPoint[], from: number, to: number): OcrPoint[] {
  const [tl, tr, br, bl] = quad as [OcrPoint, OcrPoint, OcrPoint, OcrPoint];
  const lerp = (a: OcrPoint, b: OcrPoint, t: number): OcrPoint => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  });
  return [lerp(tl, tr, from), lerp(tl, tr, to), lerp(bl, br, to), lerp(bl, br, from)];
}

// ─────────────────────────── CTC 解码 ───────────────────────────

/**
 * CTC 贪心解码。`dict` 是模型自带的字典（如 `ppocrv5_dict.txt` 的每一行）。
 *
 * 类别安排照 PaddleOCR：0 = blank，1..`dict.length` = 字典，`dict.length + 1` = 空格。
 */
export function ctcDecode(
  data: Float32Array,
  timeSteps: number,
  classes: number,
  dict: readonly string[],
): { text: string; score: number } {
  let text = '';
  let scoreSum = 0;
  let kept = 0;
  let prev = -1;
  for (let t = 0; t < timeSteps; t += 1) {
    const base = t * classes;
    let best = 0;
    let bestProb = data[base]!;
    for (let c = 1; c < classes; c += 1) {
      const p = data[base + c]!;
      if (p > bestProb) {
        bestProb = p;
        best = c;
      }
    }
    if (best !== 0 && best !== prev) {
      const ch = best <= dict.length ? dict[best - 1]! : best === dict.length + 1 ? ' ' : '';
      text += ch;
      scoreSum += bestProb;
      kept += 1;
    }
    prev = best;
  }
  return { text, score: kept > 0 ? scoreSum / kept : 0 };
}

/** 字典文本 → 行数组（丢掉结尾空行；行尾的 `\r` 一并去掉）。 */
export function parseDict(raw: string): string[] {
  const lines = raw.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// ─────────────────────────── rec ───────────────────────────

/** 一行文字 → rec 的 NCHW 输入（高度 48，宽度按长宽比，左侧对齐、右侧补零）。 */
function recInput(img: RgbImage, quad: readonly OcrPoint[]): { data: Float32Array; width: number } {
  const size = quadSize(quad);
  const ratio = size.height > 0 ? size.width / size.height : 1;
  const resizedW = Math.min(REC_MAX_WIDTH, Math.max(1, Math.ceil(REC_IMAGE_HEIGHT * ratio)));
  const inputW = Math.max(REC_MIN_WIDTH, resizedW);
  const crop = warpQuad(img, quad, resizedW, REC_IMAGE_HEIGHT);
  const plane = REC_IMAGE_HEIGHT * inputW;
  const out = new Float32Array(3 * plane);
  for (let y = 0; y < REC_IMAGE_HEIGHT; y += 1) {
    for (let x = 0; x < resizedW; x += 1) {
      const srcBase = (y * resizedW + x) * 3;
      const dst = y * inputW + x;
      for (let c = 0; c < 3; c += 1) {
        out[c * plane + dst] = (crop[srcBase + c]! / 255 - 0.5) / 0.5;
      }
    }
  }
  return { data: out, width: inputW };
}

/** 识别一个（可能超长的）裁剪框：超长则沿长边切段，结果直接接起来。 */
async function recognizeQuad(
  img: RgbImage,
  quad: readonly OcrPoint[],
  session: OcrSession,
  dict: readonly string[],
): Promise<{ text: string; score: number }> {
  const size = quadSize(quad);
  const ratio = size.height > 0 ? size.width / size.height : 1;
  const targetW = Math.ceil(REC_IMAGE_HEIGHT * ratio);
  const parts = Math.max(1, Math.ceil(targetW / REC_MAX_WIDTH));
  let text = '';
  let scoreSum = 0;
  for (let i = 0; i < parts; i += 1) {
    const piece = parts === 1 ? quad : sliceQuad(quad, i / parts, (i + 1) / parts);
    const { data, width } = recInput(img, piece);
    const out = await session.run(data, [1, 3, REC_IMAGE_HEIGHT, width]);
    const dims = out.dims;
    const classes = dims[dims.length - 1] ?? 0;
    const timeSteps = dims[dims.length - 2] ?? 0;
    const decoded = ctcDecode(out.data, timeSteps, classes, dict);
    text += decoded.text;
    scoreSum += decoded.score;
  }
  return { text, score: parts > 0 ? scoreSum / parts : 0 };
}

// ─────────────────────────── cls ───────────────────────────

/** 一行裁剪 → cls 的 NCHW 输入（直接拉成 80×160，与 PaddleOCR 的 ClsResizeImg 一致）。 */
function clsInput(img: RgbImage, quad: readonly OcrPoint[]): Float32Array {
  const crop = warpQuad(img, quad, CLS_IMAGE_WIDTH, CLS_IMAGE_HEIGHT);
  const plane = CLS_IMAGE_HEIGHT * CLS_IMAGE_WIDTH;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i += 1) {
    for (let c = 0; c < 3; c += 1) {
      out[c * plane + i] = (crop[i * 3 + c]! / 255 - 0.5) / 0.5;
    }
  }
  return out;
}

/** 这一行是不是倒了（需要转 180°）。只有超过 {@link CLS_THRESHOLD} 才认。 */
async function isUpsideDown(
  img: RgbImage,
  quad: readonly OcrPoint[],
  session: OcrSession,
): Promise<boolean> {
  const out = await session.run(clsInput(img, quad), [1, 3, CLS_IMAGE_HEIGHT, CLS_IMAGE_WIDTH]);
  const probs = out.data;
  const flipped = probs[1] ?? 0;
  return flipped > (probs[0] ?? 0) && flipped >= CLS_THRESHOLD;
}

/** 4 角点整体转 180°（等价于把裁剪旋转半圈）。 */
function rotateQuad180(quad: readonly OcrPoint[]): OcrPoint[] {
  const [tl, tr, br, bl] = quad as [OcrPoint, OcrPoint, OcrPoint, OcrPoint];
  return [br, bl, tl, tr];
}

// ─────────────────────────── 顶层 ───────────────────────────

export interface OcrPipelineOptions {
  /** 检测会话（必给）。 */
  det: OcrSession;
  /** 方向分类会话（可选；不给就跳过 180° 矫正）。 */
  cls?: OcrSession;
  /** 识别会话（可选；不给只出框、不出文字 —— 筛图模式就是这么用的）。 */
  rec?: OcrSession;
  /** 字典（`rec` 给了就必须给）。 */
  dict?: readonly string[];
  /** 覆盖 det 超参。 */
  detOptions?: Partial<DetOptions>;
}

/**
 * 跑一整张图：检测 → （方向分类）→ 识别。返回按阅读顺序排好的行。
 * 只给 `det` 时返回的行 `text` 为空 —— 那就是「这张图里有没有文字」的判据。
 */
export async function runOcrPipeline(
  img: RgbImage,
  options: OcrPipelineOptions,
): Promise<TextLine[]> {
  const boxes = await detect(img, options.det, options.detOptions ?? {});
  const lines: TextLine[] = [];
  for (const box of boxes.slice(0, MAX_LINES)) {
    let quad = box.quad;
    let text = '';
    let textScore = 0;
    if (options.rec && options.dict) {
      if (options.cls && (await isUpsideDown(img, quad, options.cls))) quad = rotateQuad180(quad);
      const decoded = await recognizeQuad(img, quad, options.rec, options.dict);
      text = decoded.text;
      textScore = decoded.score;
    }
    lines.push({ ...box, quad, text, textScore });
  }
  return lines;
}

// ─────────────────────────── 段落 ───────────────────────────

/**
 * 按行间距分段落（1 起）。判据：与上一行的垂直间隙大于两行行高的 0.8 倍就算新段落。
 * 只是给 `blocks[].parag` 用的标记，与在线版同格式（`{"Parag":{"ParagNo":n}}`）。
 */
export function assignParagraphs(lines: readonly DetBox[]): number[] {
  const out: number[] = [];
  let no = 1;
  let prevBottom = Number.NEGATIVE_INFINITY;
  let prevHeight = 0;
  for (const line of lines) {
    const height = Math.max(1, line.rect.height);
    const gap = line.rect.y - prevBottom;
    if (out.length > 0 && gap > Math.max(prevHeight, height) * 0.8) no += 1;
    out.push(no);
    prevBottom = line.rect.y + line.rect.height;
    prevHeight = height;
  }
  return out;
}
