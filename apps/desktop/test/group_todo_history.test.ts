import { Storage } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import {
  groupTodoHistoryKey,
  mergeGroupTodoHistory,
  mergeGroupTodoSources,
  readGroupTodoHistory,
  saveGroupTodoHistory,
} from '../src/renderer/src/lib/groupTodoHistory';

describe('已完成群待办记录', () => {
  it('在线只返回部分横幅时保留本地待办，同一序号采用在线状态且不重复', () => {
    const local = { sequence: '123', sourceId: '123_1', text: '本地摘要', completed: false };
    const online = { ...local, sourceId: '123_-1', text: '在线正文', completed: true };
    const other = { sequence: '456', text: '仅本地待办' };
    expect(mergeGroupTodoSources([local, other], [online])).toEqual([online, other]);
    expect(mergeGroupTodoSources([local], [])).toEqual([local]);
  });
  const done = {
    sourceId: '123_1',
    sequence: '123',
    text: '已完成事项',
    completed: true,
    updatedAt: 10,
  };
  it('完成后横幅缺席仍保留，旧的待完成快照不会覆盖已确认完成', () => {
    expect(mergeGroupTodoHistory([], [done])).toEqual([done]);
    expect(mergeGroupTodoHistory([{ ...done, completed: false, updatedAt: 9 }], [done])).toEqual([
      done,
    ]);
    expect(mergeGroupTodoHistory([done], [done])).toHaveLength(1);
    expect(
      mergeGroupTodoHistory([{ ...done, completed: false, updatedAt: 11 }], [done])[0]?.completed,
    ).toBe(false);
  });
  it('按账号、数据源及群隔离，保存后重新读取只恢复合法完成项', () => {
    const storage = new Storage();
    const key = groupTodoHistoryKey('10001', 'source-a', 123);
    saveGroupTodoHistory(
      key,
      [done, { ...done, sequence: '456', sourceId: '456_1', completed: false }],
      storage,
    );
    expect(readGroupTodoHistory(key, storage)).toEqual([done]);
    for (const other of [
      groupTodoHistoryKey('20002', 'source-a', 123),
      groupTodoHistoryKey('10001', 'source-b', 123),
      groupTodoHistoryKey('10001', 'source-a', 456),
    ])
      expect(readGroupTodoHistory(other, storage)).toEqual([]);
    storage.setItem(key, '[{"completed":true,"sequence":123,"text":"坏记录"}]');
    expect(readGroupTodoHistory(key, storage)).toEqual([]);
    storage.setItem(key, '{bad');
    expect(readGroupTodoHistory(key, storage)).toEqual([]);
  });
  it('写入失败交由界面明确提示，不冒称记录已持久化', () => {
    expect(() =>
      saveGroupTodoHistory('key', [done], {
        setItem: () => {
          throw new Error('quota');
        },
      }),
    ).toThrow('quota');
  });
});
