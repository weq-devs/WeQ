import { describe, expect, it } from 'vitest';
import {
  summarizeWorkspaceTasks,
  workspaceIndicator,
} from '../src/renderer/src/lib/workspaceIndicators';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { WorkspaceStatusDot } from '../src/renderer/src/components/WorkspaceStatusDot';

function withIds<const T>(tasks: T[]) {
  return tasks.map((task, id) => ({ ...task, id: String(id) }));
}

describe('工作菜单状态汇总', () => {
  it.each([
    [1, 0, 'running', '1'],
    [3, 7, 'running', '3'],
    [0, 5, 'finished', '5'],
    [100, 3, 'running', '99+'],
    [0, 120, 'finished', '99+'],
  ] as const)('红蓝角标显示对应来源数（在途 %s，未读 %s）', (running, finished, status, text) => {
    const markup = renderToStaticMarkup(createElement(WorkspaceStatusDot, { running, finished }));
    expect(markup).toContain(`is-${status}`);
    expect(markup).toContain(`>${text}</span>`);
  });
  it('各类在途与结束任务逐项计数，暂停和待执行漫游不贡献结束提醒', () => {
    expect(
      summarizeWorkspaceTasks({
        exports: withIds([
          { status: 'running' },
          { status: 'pending' },
          { status: 'completed' },
          { status: 'failed' },
          { status: 'cancelled' },
          { status: 'paused' },
        ]),
        clones: [
          { personaId: 'a', status: 'running' },
          { personaId: 'b', status: 'done' },
          { personaId: 'c', status: 'error' },
        ],
        roaming: withIds([
          { status: 'planned' },
          { status: 'running' },
          { status: 'pausing' },
          { status: 'paused' },
          { status: 'partial' },
          { status: 'completed' },
          { status: 'failed' },
          { status: 'cancelled' },
        ]),
        scanning: true,
        flash: withIds([
          { status: 'pending' },
          { status: 'resolving' },
          { status: 'downloading' },
          { status: 'done' },
          { status: 'failed' },
          { status: 'cancelled' },
        ]),
      }),
    ).toMatchObject({ running: 9, finished: 11, failed: 4 });
  });

  it('已完成任务再次保存只贡献一个蓝点，保存失败只贡献一个红点', () => {
    expect(
      summarizeWorkspaceTasks({
        exports: [
          { id: 'a', status: 'completed', save: { policy: { mode: 'before' }, status: 'saving' } },
          { id: 'b', status: 'completed', save: { policy: { mode: 'before' }, status: 'failed' } },
          {
            id: 'c',
            status: 'completed',
            save: { policy: { mode: 'before' }, status: 'interrupted' },
          },
        ],
      }),
    ).toMatchObject({ running: 1, finished: 2, failed: 2 });
  });

  it('蓝点覆盖但不清除红点，没有来源时不显示', () => {
    expect(workspaceIndicator(2, 3)).toBe('running');
    expect(workspaceIndicator(0, 3)).toBe('finished');
    expect(workspaceIndicator(0, 0)).toBeNull();
    expect(summarizeWorkspaceTasks({})).toMatchObject({ running: 0, finished: 0, failed: 0 });
  });
});
