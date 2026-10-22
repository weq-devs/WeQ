import { expect, it } from 'vitest';
import {
  messageBatchBlockReason,
  partitionMessageBatch,
} from '../src/renderer/src/lib/messageBatchAction';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';

const demo = createTemplateDemoData();
const own = { ...demo.messages[0]!, id: '10001', senderId: demo.user.id };
it.each(['export', 'analysis', 'delete'] as const)(
  '%s 不排除自己的正式记录，仅过滤真正不支持的来源',
  (action) => {
    const pending = { ...own, id: 'optimistic-sent', optimistic: 'sent' as const };
    const roaming = { ...own, id: 'roaming:protocol:1:2', source: 'roaming' as const };
    expect(messageBatchBlockReason(own, action)).toBeNull();
    expect(partitionMessageBatch([own, pending, roaming], action)).toMatchObject(
      action === 'export' || action === 'delete'
        ? { supported: [own, roaming], unsupported: [{ message: pending }] }
        : { supported: [own], unsupported: [{ message: pending }, { message: roaming }] },
    );
  },
);
it('删除允许移除无回执失败占位，但发送中、已受理和无法确认送达的占位必须保留', () => {
  const failed = { ...own, id: 'optimistic-failed', optimistic: 'failed' as const, msgSeq: '' };
  expect(messageBatchBlockReason(failed, 'delete')).toBeNull();
  for (const optimistic of ['sending', 'sent'] as const)
    expect(messageBatchBlockReason({ ...failed, optimistic }, 'delete')).toBeTruthy();
  expect(messageBatchBlockReason({ ...failed, optimisticRejected: true }, 'delete')).toBeTruthy();
});

it('已经持久化的自己的协议缓存支持导出和可恢复的本地删除，分析仍需正式入库', () => {
  const cached = {
    ...own,
    id: 'roaming:protocol:2:77',
    source: 'roaming' as const,
    sourceFormat: 'protocol' as const,
    localSent: true,
  };
  expect(messageBatchBlockReason(cached, 'export')).toBeNull();
  expect(messageBatchBlockReason(cached, 'delete')).toBeNull();
  expect(messageBatchBlockReason(cached, 'analysis')).toBeTruthy();
  expect(messageBatchBlockReason({ ...cached, localSent: false }, 'delete')).toBeNull();
});

it('撤回必须按当前会话逐条核对，允许复用已确认定位的漫游记录，不沿用导出的来源限制', () => {
  const roaming = { ...own, source: 'roaming' as const };
  expect(messageBatchBlockReason(own, 'recall')).toContain('撤回权限');
  expect(
    partitionMessageBatch([own, roaming], 'recall', (message) =>
      message.source === 'roaming' ? '不支持' : null,
    ),
  ).toMatchObject({ supported: [own] });
  expect(partitionMessageBatch([roaming], 'recall', () => null)).toMatchObject({
    supported: [roaming],
    unsupported: [],
  });
});
