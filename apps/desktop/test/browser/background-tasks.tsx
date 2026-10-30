import { createRoot } from 'react-dom/client';
import { CurrentTaskList } from '../../src/renderer/src/components/tasks/CurrentTaskList';
import { DialogHost } from '../../src/renderer/src/components/Dialog';
import { localBackgroundTasks } from '../../src/renderer/src/state/backgroundTasks';
import { useThemeStore } from '../../src/renderer/src/state/theme';
import type { BackgroundTaskKind } from '../../src/shared/background_task';
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
for (const [kind, name] of fixtures) {
  const id = localBackgroundTasks.start({
    kind,
    name,
    progress: kind === 'model' ? 42 : undefined,
    note: '合成数据，不发出网络请求',
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
createRoot(document.getElementById('root')!).render(
  <>
    <style>{`html,body,#root{margin:0;height:100%;background:var(--background)}main{display:flex;max-width:1040px;height:calc(100% - 32px);margin:16px auto;background:var(--weq-chat-bg)}`}</style>
    <main>
      <CurrentTaskList
        layout="split"
        exports={[]}
        cleanupBinding={{ expectedAccountUin: 'synthetic', expectedAccountConfigId: 'fixture' }}
        onSaveAll={() => {}}
        renderExport={() => null}
      />
    </main>
    <DialogHost />
  </>,
);
