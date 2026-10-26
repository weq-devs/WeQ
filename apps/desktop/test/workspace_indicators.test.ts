import { describe, expect, it } from 'vitest';
import {
  summarizeWorkspaceTasks,
  workspaceIndicator,
} from '../src/renderer/src/lib/workspaceIndicators';

describe('工作菜单状态汇总', () => {
  it('各类在途与结束任务逐项计数，暂停和待执行漫游不贡献结束提醒', () => {
    expect(
      summarizeWorkspaceTasks({
        exports: [
          { status: 'running' },
          { status: 'pending' },
          { status: 'completed' },
          { status: 'failed' },
          { status: 'cancelled' },
          { status: 'paused' },
        ],
        clones: [{ status: 'running' }, { status: 'done' }, { status: 'error' }],
        roaming: [
          { status: 'planned' },
          { status: 'running' },
          { status: 'pausing' },
          { status: 'paused' },
          { status: 'partial' },
          { status: 'completed' },
          { status: 'failed' },
          { status: 'cancelled' },
        ],
        scanning: true,
        flash: [
          { status: 'pending' },
          { status: 'resolving' },
          { status: 'downloading' },
          { status: 'done' },
          { status: 'failed' },
          { status: 'cancelled' },
        ],
      }),
    ).toEqual({ running: 9, finished: 11, failed: 4 });
  });

  it('已完成任务再次保存只贡献一个蓝点，保存失败只贡献一个红点', () => {
    expect(
      summarizeWorkspaceTasks({
        exports: [
          { status: 'completed', save: { policy: { mode: 'before' }, status: 'saving' } },
          { status: 'completed', save: { policy: { mode: 'before' }, status: 'failed' } },
          { status: 'completed', save: { policy: { mode: 'before' }, status: 'interrupted' } },
        ],
      }),
    ).toEqual({ running: 1, finished: 2, failed: 2 });
  });

  it('蓝点覆盖但不清除红点，没有来源时不显示', () => {
    expect(workspaceIndicator(2, 3)).toBe('running');
    expect(workspaceIndicator(0, 3)).toBe('finished');
    expect(workspaceIndicator(0, 0)).toBeNull();
    expect(summarizeWorkspaceTasks({})).toEqual({ running: 0, finished: 0, failed: 0 });
  });
});
