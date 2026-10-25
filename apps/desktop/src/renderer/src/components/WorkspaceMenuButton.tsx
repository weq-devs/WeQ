import { Menu, Settings } from 'lucide-react';
import { useWorkspaceMenu } from '../state/workspaceMenu';
import { useUpdateStore } from '../state/update';
import '../styles/rail-navigation.css';
import '../styles/workspace-menu.css';

export function WorkspaceMenuButton() {
  const anchor = useWorkspaceMenu((state) => state.anchor);
  const toggle = useWorkspaceMenu((state) => state.toggle);
  const running = useWorkspaceMenu((state) => state.running);
  const failed = useWorkspaceMenu((state) => state.failed);
  const update = useUpdateStore((state) => state.available);
  return (
    <button
      type="button"
      className="weq-rail-button weq-workspace-menu-trigger"
      title={failed ? `菜单 · ${failed} 项任务失败` : update ? '菜单 · 有新版本' : '菜单'}
      aria-label={`菜单${running ? `，${running} 项任务进行中` : ''}${failed ? `，${failed} 项任务失败` : ''}${update ? '，有新版本' : ''}`}
      aria-haspopup="dialog"
      aria-expanded={Boolean(anchor)}
      onClick={(event) => toggle(event.currentTarget)}
    >
      <Menu size={22} strokeWidth={1.75} aria-hidden />
      {update || failed ? <span className="weq-workspace-dot" /> : null}
      {running > 0 ? <small className="weq-workspace-count">{running}</small> : null}
    </button>
  );
}

export function WorkspaceSettingsButton({ onClick }: { onClick: () => void }) {
  const update = useUpdateStore((state) => state.available);
  return (
    <button
      type="button"
      className="weq-workspace-control"
      title={update ? '设置 · 有新版本可更新' : '设置'}
      aria-label={update ? '设置，有新版本可更新' : '设置'}
      onClick={() => {
        useWorkspaceMenu.getState().close();
        onClick();
      }}
    >
      <Settings size={18} aria-hidden />
      {update ? <span className="weq-workspace-dot" /> : null}
    </button>
  );
}
