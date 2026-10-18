import { CloudDownload, Download, ListPlus, X } from 'lucide-react';
import '../styles/conversation-directory.css';

export function ConversationSelectionToolbar({
  count,
  allSelected,
  exportReason,
  roamingReason,
  onSelectAll,
  onExport,
  onRoaming,
  onExit,
}: {
  count: number;
  allSelected: boolean;
  exportReason?: string;
  roamingReason?: string;
  onSelectAll: () => void;
  onExport: () => void;
  onRoaming: () => void;
  onExit: () => void;
}) {
  return (
    <div className="weq-conversation-selection-toolbar" role="toolbar" aria-label="会话多选操作">
      <span aria-live="polite">已选 {count}</span>
      <button
        type="button"
        title={allSelected ? '取消全选当前结果' : '全选当前结果'}
        aria-label={allSelected ? '取消全选当前结果' : '全选当前结果'}
        aria-pressed={allSelected}
        onClick={onSelectAll}
      >
        <ListPlus size={16} />
      </button>
      <button
        type="button"
        title={exportReason ?? '导出所选会话'}
        aria-label="导出所选会话"
        disabled={Boolean(exportReason)}
        onClick={onExport}
      >
        <Download size={16} />
      </button>
      <button
        type="button"
        title={roamingReason ?? '拉取所选会话漫游消息'}
        aria-label="拉取所选会话漫游消息"
        disabled={Boolean(roamingReason)}
        onClick={onRoaming}
      >
        <CloudDownload size={16} />
      </button>
      <button type="button" title="退出多选" aria-label="退出多选" onClick={onExit}>
        <X size={16} />
      </button>
    </div>
  );
}
