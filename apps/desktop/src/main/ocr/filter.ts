/**
 * 筛图判据 —— 「这张图里有没有文字？」的纯函数部分（可单测，不碰 Electron）。
 *
 * 判据是**检测框非空**，但会把面积占整图过大的框当成噪声丢掉：实测 tiny 检测模型
 * （PP-OCRv6 det tiny）在 240-420px 的正方形小图上会把整张图判成一个文字块 —— 6 个
 * 误报里 4 个是这种「整图大小的框」（见 docs/develop/ocr-models.md 第五节的实测）。
 *
 * 方向仍然是**宁松勿紧**：只丢明显不可能是文字的整图框，其余一律当有文字送去识别 ——
 * 漏判（把有文字的图跳过）比多跑一次识别的代价大得多。
 */

import type { OcrBlock } from '@weq/protocol';
import type { OcrRect } from './pipeline';

/** 单框面积占整图的比例上限：超过即视为「整图框」噪声。 */
export const OCR_FILTER_MAX_BOX_AREA_RATIO = 0.9;

export interface OcrFilterDecision {
  /** 有没有像文字的框。 */
  hasText: boolean;
  /** 保留下来的框数。 */
  boxes: number;
  /** 被当作噪声丢掉的框数（面积占比过大 / 退化的框）。 */
  dropped: number;
}

/** 检测框 → 「有没有文字」的判定。 */
export function judgeTextBoxes(
  blocks: readonly OcrBlock[],
  imageWidth: number,
  imageHeight: number,
): OcrFilterDecision {
  const imageArea = Math.max(1, imageWidth * imageHeight);
  let boxes = 0;
  let dropped = 0;
  for (const block of blocks) {
    const rect = block.rect as OcrRect | undefined;
    const w = rect?.width ?? 0;
    const h = rect?.height ?? 0;
    // 退化的框（宽高 ≤ 0）与「整图框」一样不算文字。
    if (w <= 0 || h <= 0 || (w * h) / imageArea >= OCR_FILTER_MAX_BOX_AREA_RATIO) dropped += 1;
    else boxes += 1;
  }
  return { hasText: boxes > 0, boxes, dropped };
}
