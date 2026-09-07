/**
 * 导出文本层的单测 —— 元素 → 文本片段、合并转发缩进、时间格式化。
 * 这些字符串直接进 TXT / CSV / XLSX 导出产物，格式一旦漂移用户对比两次导出
 * 就会 diff 满屏，所以把形状钉死。
 */

import { describe, expect, it } from 'vitest';
import {
  elementsToText,
  formatTime,
  forwardToText,
  messageToText,
  TABLE_HEADERS,
} from '../src/account/export/element_text';
import type { ExportedMessage } from '../src/account/export/types';
import type { ForwardMessage, RenderElement } from '../src/account/msg_view';

describe('elementToText / elementsToText', () => {
  it('text / at 直接给正文', () => {
    const els: RenderElement[] = [
      { type: 'text', data: { textContent: '你好' } } as RenderElement,
      { type: 'at', data: { textContent: '@某人 ' } } as RenderElement,
    ];
    expect(elementsToText(els)).toBe('你好@某人 ');
  });

  it('face 有 faceText 时给 [faceText]', () => {
    const els: RenderElement[] = [
      { type: 'face', data: { faceText: '微笑' } } as RenderElement,
      { type: 'face', data: {} } as RenderElement,
    ];
    expect(elementsToText(els)).toBe('[微笑][表情]');
  });

  it('pic / video / ptt 给标签；有 localPath 时追加 → 路径', () => {
    const els: RenderElement[] = [
      { type: 'pic', data: { subType: 0 } } as RenderElement,
      { type: 'pic', data: { subType: 1 } } as RenderElement,
      { type: 'video', data: { localPath: 'media/v.mp4' } } as RenderElement,
      { type: 'ptt', data: {} } as RenderElement,
    ];
    expect(elementsToText(els)).toBe('[图片][表情][视频 → media/v.mp4][语音]');
  });

  it('file / onlineFile 带文件名（空名回退）', () => {
    const els: RenderElement[] = [
      { type: 'file', data: { fileName: '报告.pdf' } } as RenderElement,
      { type: 'onlineFile', data: { fileName: '' } } as RenderElement,
    ];
    expect(elementsToText(els)).toBe('[文件: 报告.pdf][文件: ]');
  });

  it('reply 引用原元素摘要并截断到 30 字', () => {
    const els: RenderElement[] = [
      {
        type: 'reply',
        data: { origElements: [{ type: 'text', data: { textContent: '啊'.repeat(40) } }] },
      } as unknown as RenderElement,
    ];
    const out = elementsToText(els);
    expect(out).toBe(`[回复: ${'啊'.repeat(30)}…] `);
  });

  it('reply 原元素为空 → [回复] ', () => {
    const els: RenderElement[] = [{ type: 'reply', data: {} } as RenderElement];
    expect(elementsToText(els)).toBe('[回复] ');
  });

  it('grayTip 撤回 / 戳一戳 / 群提示', () => {
    const els: RenderElement[] = [
      { type: 'grayTipRevoke', data: { recallDisplayText: '对方撤回了一条消息' } } as RenderElement,
      { type: 'grayTipRevoke', data: {} } as RenderElement,
      { type: 'grayTipPoke', data: {} } as RenderElement,
      { type: 'grayTipGroup', data: {} } as RenderElement,
    ];
    expect(elementsToText(els)).toBe('[对方撤回了一条消息][撤回了一条消息][戳一戳][群提示]');
  });

  it('unknown 元素给空串（不产出垃圾）', () => {
    expect(elementsToText([{ type: 'unknown', data: {} } as RenderElement])).toBe('');
  });
});

describe('forwardToText', () => {
  it('空 / 缺失 → [合并转发]', () => {
    expect(forwardToText(undefined, 0)).toBe('[合并转发]');
    expect(forwardToText([], 0)).toBe('[合并转发]');
  });

  it('每行 `名字: 内容`，深度缩进为全角空格', () => {
    const msgs: ForwardMessage[] = [
      {
        senderName: '甲',
        elements: [{ type: 'text', data: { textContent: '第一层' } } as RenderElement],
      } as unknown as ForwardMessage,
      {
        senderName: '乙',
        elements: [
          {
            type: 'multiMsg',
            data: {
              forwardMessages: [
                {
                  senderName: '丙',
                  elements: [{ type: 'text', data: { textContent: '第二层' } } as RenderElement],
                } as unknown as ForwardMessage,
              ],
            },
          } as RenderElement,
        ],
      } as unknown as ForwardMessage,
    ];
    const out = forwardToText(msgs, 0);
    expect(out).toBe('[合并转发]\n甲: 第一层\n乙: [合并转发]\n　丙: 第二层');
  });
});

describe('formatTime / messageToText', () => {
  it('formatTime → 本地时区 YYYY-MM-DD HH:mm:ss', () => {
    // 用 Date 构造保证与实现同一时区下比较。
    const d = new Date(2026, 0, 2, 3, 4, 5);
    expect(formatTime(Math.floor(d.getTime() / 1000))).toBe('2026-01-02 03:04:05');
  });

  it('messageToText → [time] uin: content', () => {
    const d = new Date(2026, 5, 1, 12, 0, 0);
    const m = {
      sendTime: Math.floor(d.getTime() / 1000),
      senderUin: '10001',
      elements: [{ type: 'text', data: { textContent: 'hi' } } as RenderElement],
    } as unknown as ExportedMessage;
    expect(messageToText(m)).toBe('[2026-06-01 12:00:00] 10001: hi');
  });

  it('TABLE_HEADERS 形状（tabular 导出依赖列序）', () => {
    expect(TABLE_HEADERS).toEqual(['时间', '发送者QQ', '发送者ID', '内容', '消息ID', '序号']);
  });
});
