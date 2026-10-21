import { expect, it } from 'vitest';
import { deletionIdentity, hiddenDeletionSequences } from '../src/renderer/src/lib/messageDeletion';
import { messageGapCount } from '../src/renderer/src/im-template/template/messageGap';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';

it('隐藏漫游重开后无缓存行仍保留缺口序号，QQ 原库隐藏使用实际消息序号', () => {
  const base = createTemplateDemoData().messages[0]!;
  const messages = [{ ...base, id: '101', msgSeq: '2' }];
  expect(
    hiddenDeletionSequences(
      messages,
      new Set([
        '101',
        'roaming:protocol:4:9007199254740993002',
        'roaming:native:4:9007199254740993002',
        'roaming:5:6',
        'malformed',
      ]),
    ),
  ).toEqual(['4', '5', '2']);
  expect(hiddenDeletionSequences(messages, new Set())).toEqual([]);
});

it('删除单条造成的空窗可显式显示，普通单条空窗仍沿用原规则', () => {
  const base = createTemplateDemoData().messages[0]!;
  const previous = { ...base, id: '1', msgSeq: '1' };
  const next = { ...base, id: '3', msgSeq: '3' };
  expect(messageGapCount(previous, next, false)).toBe(0);
  expect(messageGapCount(previous, next, true)).toBe(1);
});

it('同一缓存消息升级格式后仍匹配删除标记，不混淆 QQ 原库和同序号其他消息', () => {
  expect(deletionIdentity('roaming:native:2:77')).toBe(deletionIdentity('roaming:protocol:2:77'));
  expect(deletionIdentity('roaming:2:77')).toBe(deletionIdentity('roaming:protocol:2:77'));
  expect(deletionIdentity('77')).not.toBe(deletionIdentity('roaming:2:77'));
  expect(deletionIdentity('roaming:2:78')).not.toBe(deletionIdentity('roaming:2:77'));
});
