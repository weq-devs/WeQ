import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { CurrentTaskList } from '../../src/renderer/src/components/tasks/CurrentTaskList';
import { DialogHost } from '../../src/renderer/src/components/Dialog';
import { localBackgroundTasks } from '../../src/renderer/src/state/backgroundTasks';
import { useThemeStore } from '../../src/renderer/src/state/theme';
import { useViewState } from '../../src/renderer/src/state/view';
import type { BackgroundTaskKind } from '../../src/shared/background_task';
import type { UiTask } from '../../src/renderer/src/views/export/TaskList';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/settings-controls.css';
import '../../src/renderer/src/styles/workspace-menu.css';

const fixtures: [BackgroundTaskKind, string][] = [
  ['model', '语音转写模型 · synthetic-model'],
  ['update', 'WeQ 更新包'],
  ['database', '数据库体检 · synthetic.db'],
  ['backup', 'WeQ 配置备份'],
  ['favorite-import', '收藏表情导入'],
  ['forward', '合成目标群逐条转发'],
  ['album-upload', '群相册长文件名-video-with-a-long-filename-for-layout-testing.mp4'],
  ['resource', '资源扫描与清理'],
];
useViewState.setState({ openedUin: 'synthetic' });
for (const [kind, name] of fixtures) {
  const id = localBackgroundTasks.start({
    kind,
    name,
    progress: kind === 'model' ? 42 : undefined,
    note: '合成数据，不发出网络请求',
    ...(kind === 'database'
      ? { destination: 'db-checkup' as const, scope: { uin: 'synthetic' } }
      : {}),
  });
  if (kind === 'forward') {
    localBackgroundTasks.setActions(id, [
      {
        id: 'stop',
        label: '停止向此会话发送',
        run: () => {
          localBackgroundTasks.finish(id, 'cancelled', { note: '已停止后续转发' });
          localBackgroundTasks.setActions(id, []);
        },
      },
    ]);
  } else if (kind === 'favorite-import' || kind === 'album-upload') {
    localBackgroundTasks.finish(id, 'paused', {
      statusLabel: '部分结果待核对',
      note: '已提交，部分操作未取得读回确认',
      details: [
        '第 1 项：已确认',
        '第 2 项：读回失败，保留未确认状态，不自动重传',
        'synthetic-long-error-abcdefghijklmnopqrstuvwxyz-0123456789-abcdefghijklmnopqrstuvwxyz-0123456789-abcdefghijklmnopqrstuvwxyz',
      ],
    });
  } else if (kind === 'database') {
    localBackgroundTasks.finish(id, 'failed', { note: '合成体检失败：目标文件当前不可读取' });
  } else if (kind !== 'model') {
    localBackgroundTasks.finish(id, 'completed', {
      note: kind === 'backup' ? '备份已生成；清除任务不删除备份文件' : '操作完成',
    });
  }
}
declare global {
  interface Window {
    backgroundTheme(dark: boolean, accent: string, background: string): void;
  }
}
window.backgroundTheme = (dark, accent, background) => {
  useThemeStore.getState().setPreference(dark ? 'dark' : 'light');
  useThemeStore.getState().setAccent(accent);
  document.documentElement.dataset.background = background;
};
const compact = new URLSearchParams(location.search).has('compact');
function Fixture() {
  const [tasks, setTasks] = useState<UiTask[]>(
    compact
      ? [
          {
            id: 'export-quick',
            name: '合成导出-long-conversation-name-for-compact-menu',
            kind: 'c2c',
            format: 'json',
            status: 'running',
            progress: 35,
            current: 35,
            total: 100,
          },
          {
            id: 'export-saved',
            name: '合成已保存结果',
            kind: 'c2c',
            format: 'json',
            status: 'completed',
            progress: 100,
            current: 1,
            total: 1,
            save: { status: 'saved', path: '/synthetic/saved.json' },
            reportPath: '/synthetic/report',
          },
        ]
      : [],
  );
  const update = (task: UiTask, patch: Partial<UiTask>) =>
    setTasks((items) => items.map((item) => (item.id === task.id ? { ...item, ...patch } : item)));
  return (
    <>
      <style>{`html,body,#root{margin:0;height:100%;background:var(--background)}main{display:flex;width:calc(100% - 16px);max-width:${compact ? '390px' : '1040px'};height:calc(100% - 32px);margin:16px auto;background:var(--weq-chat-bg)}`}</style>
      <main>
        <CurrentTaskList
          layout={compact ? 'compact' : 'split'}
          exports={tasks}
          exportActions={{
            pause: (task) => update(task, { status: 'paused', canResume: true }),
            resume: (task) => update(task, { status: 'running', canResume: false }),
            cancel: (task) => update(task, { status: 'cancelled', canResume: false }),
            remove: (task) => setTasks((items) => items.filter((item) => item.id !== task.id)),
            save: (task) => {
              window.taskQuickCalls?.push({ action: 'save', input: task.id });
            },
            openSaved: (task, reveal) => {
              window.taskQuickCalls?.push({
                action: 'openSaved',
                input: { taskId: task.id, reveal },
              });
            },
            report: (task) => {
              window.taskQuickCalls?.push({ action: 'report', input: task.id });
            },
          }}
          onOpenDetail={() => {
            throw new Error('快捷操作不应展开完整面板');
          }}
          cleanupBinding={{ expectedAccountUin: 'synthetic', expectedAccountConfigId: 'fixture' }}
          renderExport={() => null}
        />
      </main>
      <DialogHost />
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
