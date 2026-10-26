import { Storage } from 'happy-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assistantResultVersion,
  readWorkspaceResults,
  rememberWorkspaceResults,
} from '../src/renderer/src/lib/workspaceReadState';
import { useWorkspaceMenu } from '../src/renderer/src/state/workspaceMenu';

beforeEach(() => vi.stubGlobal('localStorage', new Storage()));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('工作菜单已读持久化', () => {
  it('按账号配置和结果种类隔离，只保存结果标识', () => {
    rememberWorkspaceResults('a/config', 'tasks', { 'export:a': 'completed:100' });
    rememberWorkspaceResults('a/config', 'assistant', { session: 'version-1' });
    expect(readWorkspaceResults('a/config', 'tasks')).toEqual({ 'export:a': 'completed:100' });
    expect(readWorkspaceResults('a/config', 'assistant')).toEqual({ session: 'version-1' });
    expect(readWorkspaceResults('a/config-2', 'tasks')).toEqual({});
    expect(readWorkspaceResults('b/config', 'assistant')).toEqual({});
  });

  it('相同快照不重复写入，空记录删除存储', () => {
    const write = vi.spyOn(window.localStorage, 'setItem');
    rememberWorkspaceResults('a', 'tasks', { task: 'result' });
    rememberWorkspaceResults('a', 'tasks', { task: 'result' });
    expect(write).toHaveBeenCalledOnce();
    rememberWorkspaceResults('a', 'tasks', {});
    expect(window.localStorage.length).toBe(0);
  });

  it.each(['{broken', 'null', '[]', '1', '{"valid":"result","bad":42}'])(
    '损坏或非预期数据安全降级：%s',
    (stored) => {
      rememberWorkspaceResults('a', 'tasks', { task: 'result' });
      window.localStorage.setItem(window.localStorage.key(0)!, stored);
      expect(readWorkspaceResults('a', 'tasks')).toEqual(
        stored.includes('valid') ? { valid: 'result' } : {},
      );
    },
  );

  it('读写被禁用时不打断操作，仍在本窗口清除已读结果', () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('禁用读取');
    });
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('配额用尽');
    });
    vi.spyOn(window.localStorage, 'removeItem').mockImplementation(() => {
      throw new Error('禁用写入');
    });
    expect(readWorkspaceResults('disabled', 'tasks')).toEqual({});
    expect(() => rememberWorkspaceResults('disabled', 'tasks', { task: 'result' })).not.toThrow();
    expect(() => rememberWorkspaceResults('disabled', 'tasks', {})).not.toThrow();
    const store = useWorkspaceMenu.getState();
    store.syncTasks('disabled', [
      { id: 'task', result: 'result', activity: 'finished', failed: false },
    ]);
    store.readTasks();
    expect(useWorkspaceMenu.getState().finished).toBe(0);
  });

  it('同一回答的流式现场和持久化历史指纹相同，新回答或轮次不同且不含原文', () => {
    const turns = [
      { role: 'user', text: '合成问题' },
      { role: 'assistant', text: '合成答案' },
    ];
    const result = assistantResultVersion(turns);
    expect(
      assistantResultVersion(turns.map((turn, index) => ({ ...turn, id: String(index), ts: 100 }))),
    ).toBe(result);
    expect(assistantResultVersion([...turns, ...turns])).not.toBe(result);
    expect(
      assistantResultVersion([...turns.slice(0, 1), { role: 'assistant', text: '另一答案' }]),
    ).not.toBe(result);
    expect(result).toMatch(/^[0-9a-f]+$/);
    expect(result).not.toContain('合成');
  });
});
