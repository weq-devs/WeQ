/**
 * 筛图判据单测。
 *
 * 回归点：判据最初写成了按 `{left,top,right,bottom}` 算面积（管线给的其实是
 * `{x,y,width,height}`），于是每个框的宽高都算成 0、全部被当噪声丢掉 —— 筛图会把
 * **每一张**图都判成「没有文字」，批量 OCR 直接空转。这里把框的形状钉死。
 */

import { describe, expect, it } from 'vitest';
import type { OcrBlock } from '@weq/protocol';
import { judgeTextBoxes, OCR_FILTER_MAX_BOX_AREA_RATIO } from '../src/main/ocr/filter';

/** 一个只有外接矩形的检测框（筛图只看矩形，不看文字）。 */
function box(x: number, y: number, width: number, height: number): OcrBlock {
  return {
    text: '',
    rect: { x, y, width, height },
    quad: [],
    parag: '',
    field2: 0,
  } as unknown as OcrBlock;
}

describe('judgeTextBoxes', () => {
  it('有正常大小的框 → 有文字', () => {
    const r = judgeTextBoxes([box(10, 10, 120, 30), box(10, 60, 200, 28)], 800, 600);
    expect(r).toEqual({ hasText: true, boxes: 2, dropped: 0 });
  });

  it('一个框都没有 → 没有文字', () => {
    expect(judgeTextBoxes([], 800, 600)).toEqual({ hasText: false, boxes: 0, dropped: 0 });
  });

  it('整图大小的框当成噪声丢掉（tiny 模型在正方形小图上的误报）', () => {
    const r = judgeTextBoxes([box(0, 0, 300, 300)], 300, 300);
    expect(r).toEqual({ hasText: false, boxes: 0, dropped: 1 });
  });

  it('大框丢掉、小框照常留下（同一张图上还有真文字时不漏判）', () => {
    const r = judgeTextBoxes([box(0, 0, 300, 300), box(20, 200, 90, 24)], 300, 300);
    expect(r).toEqual({ hasText: true, boxes: 1, dropped: 1 });
  });

  it('退化的框（宽高为 0）不算文字', () => {
    expect(judgeTextBoxes([box(5, 5, 0, 10)], 800, 600)).toEqual({
      hasText: false,
      boxes: 0,
      dropped: 1,
    });
  });

  it('阈值就是「面积占比 ≥ 90%」', () => {
    const side = 100;
    const area = side * side;
    const atLimit = Math.ceil(Math.sqrt(OCR_FILTER_MAX_BOX_AREA_RATIO * area));
    expect(judgeTextBoxes([box(0, 0, atLimit, atLimit)], side, side).dropped).toBe(1);
    expect(judgeTextBoxes([box(0, 0, atLimit - 2, atLimit - 2)], side, side).dropped).toBe(0);
  });
});
