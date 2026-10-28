import { Menu, Settings } from 'lucide-react';
import { useWorkspaceMenu } from '../state/workspaceMenu';
import { useUpdateStore } from '../state/update';
import { WorkspaceStatusDot } from './WorkspaceStatusDot';
import { preloadWorkspace } from './lazyWorkspaces';
import '../styles/rail-navigation.css';
import '../styles/workspace-menu.css';

export function WorkspaceMenuButton() {
  const anchor = useWorkspaceMenu((state) => state.anchor);
  const toggle = useWorkspaceMenu((state) => state.toggle);
  const running = useWorkspaceMenu((state) => state.running);
  const failed = useWorkspaceMenu((state) => state.failed);
  const finished = useWorkspaceMenu((state) => state.finished);
  const assistant = useWorkspaceMenu((state) => state.assistant);
  const assistantUnread = useWorkspaceMenu((state) => state.assistantUnread);
  const update = useUpdateStore((state) => state.available);
  const label = `菜单${running ? `，${running} 项任务进行中` : ''}${finished ? `，${finished} 项任务已结束` : ''}${failed ? `，${failed} 项任务失败` : ''}${assistant === 'running' ? '，助手回答中' : assistant === 'finished' ? '，助手回答已结束' : ''}${update ? '，有新版本' : ''}`;
  return (
    <button
      type="button"
      className="weq-rail-button weq-workspace-menu-trigger"
      title={label}
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={Boolean(anchor)}
      onPointerEnter={() => preloadWorkspace('export')}
      onFocus={() => preloadWorkspace('export')}
      onClick={(event) => toggle(event.currentTarget)}
    >
      <Menu size={22} strokeWidth={1.75} aria-hidden />
      <WorkspaceStatusDot
        running={running + Number(assistant === 'running')}
        finished={finished + Number(assistantUnread) + Number(update)}
      />
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
      onPointerEnter={() => preloadWorkspace('settings')}
      onFocus={() => preloadWorkspace('settings')}
      onClick={() => {
        useWorkspaceMenu.getState().close();
        onClick();
      }}
    >
      <Settings size={18} aria-hidden />
      <WorkspaceStatusDot running={0} finished={Number(update)} />
    </button>
  );
}
