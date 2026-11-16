import { describe, expect, it } from 'vitest';
import { buildSendElems, encode, ELEM, type SendElement } from '@weq/protocol';
import {
  codecElementToSeg,
  renderElementsToSegs,
  segsToRenderElements,
  segsToSendElements,
} from '../src/renderer/src/components/mergeForward/model';
import { forwardUnsupportedReason, repeatSendPlan } from '../src/renderer/src/lib/messageRepeat';

const flash = {
  type: 'markdown',
  data: {
    markdownContent: '[闪传](mqqapi://fixture)',
    markdownTextSummary: '[QQ闪传]',
    flashTransferInfo: { fileSetId: 'fixture-fileset' },
  },
};

describe('闪传卡片转发', () => {
  it.each([false, true])('忽略空文本占位并保留文件集 ID（群聊：%s）', (group) => {
    const elements = [
      { type: 'text', data: { textContent: '' } },
      flash,
      { type: 'text', data: {} },
    ];
    expect(forwardUnsupportedReason(elements)).toBeNull();
    const plan = repeatSendPlan(elements, new Map(), group);
    expect(plan).toEqual({
      kind: 'elements',
      elements: [{ kind: 'markdown', ...flash.data }],
    });
    if (plan.kind !== 'elements') throw new Error('缺少闪传发送计划');
    expect(() =>
      buildSendElems(plan.elements as SendElement[], { scene: group ? 'group' : 'c2c' }),
    ).not.toThrow();
  });

  it('原始元素、旧草稿、预览及合并转发转换均保留文件集 ID', () => {
    const seg = codecElementToSeg({ kind: flash.type, ...flash.data });
    if (!seg) throw new Error('缺少闪传分段');
    for (const segs of [[seg], renderElementsToSegs([flash])]) {
      expect(segsToSendElements(segs)).toEqual([{ kind: 'markdown', ...flash.data }]);
      expect(segsToRenderElements(segs)).toMatchObject([flash]);
    }
  });

  it('协议编码保留已声明的 markdown 闪传字段，不只是本地预览保留 ID', () => {
    const element = { kind: 'markdown' as const, ...flash.data };
    const [wire] = buildSendElems([element]);
    const common = wire?.commonElem as { pbElem: Uint8Array };
    // 独立检查 protobuf tag 7 -> tag 1 的黄金字节，不用待测 schema 自证。
    const suffix = Buffer.concat([
      Buffer.from([0x3a, 0x11, 0x0a, 0x0f]),
      Buffer.from('fixture-fileset'),
    ]);
    expect(Buffer.from(common.pbElem).subarray(-suffix.length)).toEqual(suffix);
    expect(() => encode(ELEM, wire!)).not.toThrow();
  });
});
