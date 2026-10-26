import { useState, useSyncExternalStore } from 'react';
import { RefreshCw } from 'lucide-react';
import { useAppDialog } from '../../lib/dialogUtils';
import { useViewState } from '../../state/view';
import { CloneProgressModal } from './CloneProgressModal';
import { getCloneTasks, startCloneUpdate, subscribeCloneTasks } from './cloneTaskStore';

export function CloneUpdateButton({
  persona,
}: {
  persona: {
    id: string;
    name: string;
    sourceUin?: string;
    training?: { mode: 'private' | 'group' };
  };
}) {
  const dialog = useAppDialog();
  const accountId = useViewState((state) => state.openedUin);
  const tasks = useSyncExternalStore(subscribeCloneTasks, getCloneTasks);
  const task = tasks.find((item) => item.accountId === accountId && item.personaId === persona.id);
  const [confirming, setConfirming] = useState(false);
  const [progressOpen, setProgressOpen] = useState(false);
  async function refresh() {
    if (confirming || task?.status === 'running' || !accountId) return;
    setConfirming(true);
    try {
      const confirmed = await dialog.confirm(
        `更新「${persona.name}」`,
        '使用最新聊天记录重新训练画像，保留名称、配置、聊天历史、记忆和群聊关系。语料将发送至当前配置的模型服务商；沿用原训练范围，旧版未记录范围时仅使用私聊。更新失败会保留旧画像。',
        { okLabel: '更新画像' },
      );
      if (!confirmed || useViewState.getState().openedUin !== accountId) return;
      setProgressOpen(true);
      void startCloneUpdate({
        personaId: persona.id,
        name: persona.name,
        uin: persona.sourceUin,
        mode: persona.training?.mode,
      });
    } finally {
      setConfirming(false);
    }
  }
  return (
    <>
      <button
        type="button"
        className="weq-set-btn"
        disabled={confirming || !accountId || task?.status === 'running'}
        onClick={() => void refresh()}
      >
        <RefreshCw size={14} aria-hidden="true" />
        更新画像
      </button>
      {progressOpen && task ? (
        <CloneProgressModal
          task={task}
          onHide={() => setProgressOpen(false)}
          onOpenPersona={() => setProgressOpen(false)}
          onDismiss={() => setProgressOpen(false)}
        />
      ) : null}
    </>
  );
}
