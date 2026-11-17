import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BackgroundTaskDetails } from '../../src/renderer/src/components/tasks/BackgroundTaskDetails';
import {
  BACKGROUND_TASK_LABELS,
  BACKGROUND_TASK_ICONS,
} from '../../src/renderer/src/components/tasks/BackgroundTaskDetails.shared';
import { LongTaskRow } from '../../src/renderer/src/components/tasks/LongTaskRow';
import { StageRow } from '../../src/renderer/src/views/export/TaskList';
import { CalendarScanProgress } from '../../src/renderer/src/components/CalendarScanProgress';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import type { BackgroundTask, BackgroundTaskKind } from '../../src/shared/background_task';
import '../../src/renderer/src/styles/index.css';

ensureThemeInitialized();
const kinds: BackgroundTaskKind[] = [
  'model',
  'update',
  'database',
  'backup',
  'favorite-import',
  'forward',
  'album-upload',
  'resource',
  'analysis',
];
const tasks = kinds.map(
  (kind): BackgroundTask => ({
    id: kind,
    kind,
    name: `${BACKGROUND_TASK_LABELS[kind]} · 合成任务`,
    status:
      kind === 'database'
        ? 'failed'
        : kind === 'backup'
          ? 'completed'
          : kind === 'update'
            ? 'paused'
            : 'running',
    progress: kind === 'resource' ? undefined : kind === 'backup' ? 100 : 42,
    note:
      kind === 'database'
        ? '合成错误：目标文件读取失败，已保留完成部分'
        : '正在处理合成输入 /synthetic/任务目录/very-long-filename-without-spaces.bin',
    startedAt: Date.now() - 65_000,
    updatedAt: Date.now(),
    finishedAt: ['database', 'backup', 'update'].includes(kind) ? Date.now() : undefined,
    actions: [],
    logs: Array.from({ length: 30 }, (_, seq) => ({
      seq,
      ts: Date.now() - 30_000 + seq * 1000,
      stage: 'task',
      level: seq === 8 ? 'warn' : 'info',
      text: `${BACKGROUND_TASK_LABELS[kind]}：合成日志 ${seq + 1} · 已处理 ${seq * 8} 个条目`,
    })),
  }),
);
Object.assign(window, { taskProgressQa: { theme: useThemeStore } });
function Fixture() {
  const [selected, setSelected] = useState(tasks[0]!);
  return (
    <main className="task-fixture">
      <style>{`
        body { margin: 0; background: var(--weq-bg-surface); color: var(--weq-fg-primary); }
        .task-fixture { max-width: 1100px; margin: auto; padding: 12px; }
        .task-fixture-columns { display: grid; grid-template-columns: minmax(0, 320px) minmax(0, 1fr); gap: 20px; }
        .task-fixture-list { height: 620px; overflow: auto; }
        .task-fixture-detail { min-width: 0; }
        .task-fixture-samples { margin-top: 20px; display: grid; gap: 12px; }
        @media (max-width: 700px) { .task-fixture-columns { grid-template-columns: minmax(0, 1fr); } .task-fixture-list { height: 210px; } }
      `}</style>
      <div className="task-fixture-columns">
        <div className="task-fixture-list">
          {tasks.map((task) => {
            const Icon = BACKGROUND_TASK_ICONS[task.kind];
            return (
              <div key={task.id} data-kind={task.kind}>
                <LongTaskRow
                  task={{
                    ...task,
                    kind: BACKGROUND_TASK_LABELS[task.kind],
                    icon: <Icon size={16} />,
                    detail: null,
                  }}
                  active={selected.id === task.id}
                  onSelect={() => setSelected(task)}
                />
              </div>
            );
          })}
        </div>
        <div className="task-fixture-detail">
          <BackgroundTaskDetails
            entry={{ source: 'window', task: selected }}
            scope={null}
            refresh={async () => {}}
          />
          <div className="task-fixture-samples">
            <StageRow
              stage={{
                key: 'media',
                label: '导出媒体',
                status: 'running',
                current: 42,
                total: 100,
              }}
              logs={[]}
              onShowFailures={() => {}}
            />
            <CalendarScanProgress
              days={Array.from({ length: 10 }, (_, index) => ({
                day: `2020-11-${String(index + 1).padStart(2, '0')}`,
                complete: index < 3,
                errors: [],
              }))}
            />
          </div>
        </div>
      </div>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient()}>
    <Fixture />
  </QueryClientProvider>,
);
