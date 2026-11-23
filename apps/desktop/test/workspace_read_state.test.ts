import { Storage } from 'happy-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readTaskResults, rememberTaskResults } from '../src/renderer/src/lib/workspaceReadState';
import { useWorkspaceMenu } from '../src/renderer/src/state/workspaceMenu';

beforeEach(() => vi.stubGlobal('localStorage', new Storage()));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('工作菜单已读持久化', () => {
  it('按账号和配置隔离，只保存任务结果标识', () => {
    rememberTaskResults('a/config', { 'export:a': 'completed:100' });
    expect(readTaskResults('a/config')).toEqual({ 'export:a': 'completed:100' });
    expect(readTaskResults('a/config-2')).toEqual({});
    expect(readTaskResults('b/config')).toEqual({});
  });

  it('相同快照不重复写入，空记录删除存储', () => {
    const write = vi.spyOn(window.localStorage, 'setItem');
    rememberTaskResults('a', { task: 'result' });
    rememberTaskResults('a', { task: 'result' });
    expect(write).toHaveBeenCalledOnce();
    rememberTaskResults('a', {});
    expect(window.localStorage.length).toBe(0);
  });

  it.each(['{broken', 'null', '[]', '1', '{"valid":"result","bad":42}'])(
    '损坏或非预期数据安全降级：%s',
    (stored) => {
      rememberTaskResults('a', { task: 'result' });
      window.localStorage.setItem(window.localStorage.key(0)!, stored);
      expect(readTaskResults('a')).toEqual(stored.includes('valid') ? { valid: 'result' } : {});
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
    expect(readTaskResults('disabled')).toEqual({});
    expect(() => rememberTaskResults('disabled', { task: 'result' })).not.toThrow();
    expect(() => rememberTaskResults('disabled', {})).not.toThrow();
    const store = useWorkspaceMenu.getState();
    store.syncTasks('disabled', [
      { id: 'task', result: 'result', activity: 'finished', failed: false },
    ]);
    store.readTasks();
    expect(useWorkspaceMenu.getState().finished).toBe(0);
  });
});
