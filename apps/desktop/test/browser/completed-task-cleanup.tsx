import { useState } from 'react';
import { ListTodo, Maximize2 } from 'lucide-react';
import { EmptyState } from '../../src/renderer/src/components/EmptyState';
import { createRoot } from 'react-dom/client';
import { CurrentTaskList } from '../../src/renderer/src/components/tasks/CurrentTaskList';
import { DialogHost, Modal, useDialog } from '../../src/renderer/src/components/Dialog';
import { ToastHost } from '../../src/renderer/src/components/Toast';
import { OverlayAnchorProvider } from '../../src/renderer/src/lib/overlayAnchor';
import { useThemeStore } from '../../src/renderer/src/state/theme';
import type { UiTask } from '../../src/renderer/src/views/export/TaskList';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/settings-controls.css';
import '../../src/renderer/src/styles/long-tasks.css';
import '../../src/renderer/src/styles/workspace-menu.css';
import '../../src/renderer/src/styles/workspace-tools.css';

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
    cleanupMenuTasks: (count: number) => void;
  }
}
window.cleanupTheme = (dark, accent) => {
  useThemeStore.getState().setPreference(dark ? 'dark' : 'light');
  useThemeStore.getState().setAccent(accent);
};
function TaskMenu() {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [count, setCount] = useState(2);
  const [expanded, setExpanded] = useState(false);
  window.cleanupMenuTasks = setCount;
  return (
    <>
      <button type="button" onClick={(event) => setAnchor(event.currentTarget)}>
        打开任务菜单
      </button>
      <Modal
        open={Boolean(anchor)}
        presentation="popover"
        anchor={anchor}
        width={expanded ? 1000 : 392}
        className={`weq-workspace-menu ${expanded ? 'is-expanded' : 'is-compact'}`}
        onClose={() => setAnchor(null)}
        title="任务"
      >
        <div className="weq-workspace-menu-body">
          <div
            data-retained-panel
            style={{ display: 'flex', flex: 1, minHeight: 0, flexDirection: 'column' }}
          >
            <div className="weq-export-tool is-tasks">
              <div className="weq-task-workspace">
                <CurrentTaskList
                  layout={expanded ? 'split' : 'compact'}
                  toolbarAction={
                    <button
                      type="button"
                      className="weq-workspace-control"
                      title="打开完整任务面板"
                      aria-label="打开完整任务面板"
                      onClick={() => setExpanded(!expanded)}
                    >
                      <Maximize2 size={16} />
                    </button>
                  }
                  exports={Array.from({ length: count }, (_, index) => ({
                    ...task,
                    id: `menu-${index}`,
                    status: index === 0 ? 'completed' : 'running',
                  }))}
                  cleanupBinding={{
                    expectedAccountUin: 'fixture',
                    expectedAccountConfigId: 'fixture',
                  }}
                  renderExport={(item) => <p>{item.name}</p>}
                />
              </div>
            </div>
          </div>
        </div>
        <nav className="weq-workspace-actions" aria-label="内容工具">
          {['分析', '导出', '查看', '合成'].map((label) => (
            <button key={label} type="button">
              <ListTodo />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="weq-workspace-controls">合成底栏</div>
      </Modal>
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <OverlayAnchorProvider>
    <style>{`html,body,#root{margin:0;min-height:100%;background:var(--background)}main{max-width:680px;margin:16px auto;background:var(--weq-chat-bg)}`}</style>
    <main>
      <TaskMenu />
      {new URLSearchParams(location.search).has('empty-gallery') ? (
        <>
          <EmptyState compact title="暂无任务" icon={<ListTodo />} />
          <EmptyState title="暂无会话" />
        </>
      ) : null}
      <CurrentTaskList
        exports={[
          task,
          { ...task, id: 'failed', name: '合成失败任务', status: 'failed' },
          { ...task, id: 'interrupted', name: '合成保存中断任务', save: { status: 'interrupted' } },
          { ...task, id: 'running', name: '合成进行中任务', status: 'running' },
        ]}
        cleanupBinding={{ expectedAccountUin: 'fixture', expectedAccountConfigId: 'fixture' }}
        renderExport={(item) => <p>{item.name}</p>}
      />
    </main>
    <aside style={{ position: 'fixed', right: 16, bottom: 16 }}>
      <button onClick={() => useDialog.getState().showInfo('信息提示', '合成信息内容。')}>
        信息提示
      </button>
      <button onClick={() => useDialog.getState().showError('清除失败', '请查看最新任务状态。')}>
        错误提示
      </button>
    </aside>
    <DialogHost />
    <ToastHost />
  </OverlayAnchorProvider>,
);
