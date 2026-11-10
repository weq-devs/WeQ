import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CurrentTaskList } from '../../src/renderer/src/components/tasks/CurrentTaskList';
import { DialogHost, Modal, useDialog } from '../../src/renderer/src/components/Dialog';
import { OverlayAnchorProvider } from '../../src/renderer/src/lib/overlayAnchor';
import { useThemeStore } from '../../src/renderer/src/state/theme';
import type { UiTask } from '../../src/renderer/src/views/export/TaskList';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/settings-controls.css';
import '../../src/renderer/src/styles/long-tasks.css';
import '../../src/renderer/src/styles/workspace-menu.css';

const task: UiTask = {
  id: 'fixture',
  name: '合成聊天记录导出',
  kind: 'c2c',
  format: 'json',
  status: 'completed',
  progress: 100,
  current: 1,
  total: 1,
};
declare global {
  interface Window {
    cleanupTheme: (dark: boolean, accent: string) => void;
  }
}
window.cleanupTheme = (dark, accent) => {
  useThemeStore.getState().setPreference(dark ? 'dark' : 'light');
  useThemeStore.getState().setAccent(accent);
};
function TaskMenu() {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  return (
    <>
      <button type="button" onClick={(event) => setAnchor(event.currentTarget)}>
        打开任务菜单
      </button>
      <Modal
        open={Boolean(anchor)}
        presentation="popover"
        anchor={anchor}
        width={392}
        className="weq-workspace-menu is-compact"
        onClose={() => setAnchor(null)}
        title="任务"
      >
        <CurrentTaskList
          layout="compact"
          exports={[task, { ...task, id: 'menu-running', status: 'running' }]}
          cleanupBinding={{ expectedAccountUin: 'fixture', expectedAccountConfigId: 'fixture' }}
          onSaveAll={() => {}}
          renderExport={(item) => <p>{item.name}</p>}
        />
      </Modal>
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <OverlayAnchorProvider>
    <style>{`html,body,#root{margin:0;min-height:100%;background:var(--background)}main{max-width:680px;margin:16px auto;background:var(--weq-chat-bg)}`}</style>
    <main>
      <TaskMenu />
      <CurrentTaskList
        exports={[
          task,
          { ...task, id: 'failed', name: '合成失败任务', status: 'failed' },
          { ...task, id: 'interrupted', name: '合成保存中断任务', save: { status: 'interrupted' } },
          { ...task, id: 'running', name: '合成进行中任务', status: 'running' },
        ]}
        cleanupBinding={{ expectedAccountUin: 'fixture', expectedAccountConfigId: 'fixture' }}
        onSaveAll={() => {}}
        renderExport={(item) => <p>{item.name}</p>}
      />
    </main>
    <aside style={{ position: 'fixed', right: 16, bottom: 16 }}>
      <button onClick={() => useDialog.getState().showInfo('清除完成', '已清除 2 项任务。')}>
        信息提示
      </button>
      <button onClick={() => useDialog.getState().showError('清除失败', '请查看最新任务状态。')}>
        错误提示
      </button>
    </aside>
    <DialogHost />
  </OverlayAnchorProvider>,
);
