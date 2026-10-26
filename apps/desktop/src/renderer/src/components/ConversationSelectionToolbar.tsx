import { CloudDownload, Download, Users, MailOpen } from 'lucide-react';
import '../styles/conversation-directory.css';

export function ConversationSelectionToolbar({
  exportReason,
  roamingReason,
  rosterReason,
  readStateReason,
  onExport,
  onRoaming,
  onRoster,
  onReadState,
}: {
  exportReason?: string;
  roamingReason?: string;
  rosterReason?: string;
  readStateReason?: string;
  onExport: () => void;
  onRoaming: () => void;
  onRoster: () => void;
  onReadState: () => void;
}) {
  return (
    <div className="weq-conversation-selection-toolbar" role="toolbar" aria-label="会话多选操作">
      <button
        type="button"
        title={roamingReason ?? '拉取所选会话漫游消息'}
        aria-label="拉取所选会话漫游消息"
        disabled={Boolean(roamingReason)}
        onClick={onRoaming}
      >
        <CloudDownload size={16} />
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
        title={rosterReason ?? '导出名单'}
        aria-label="导出名单"
        disabled={Boolean(rosterReason)}
        onClick={onRoster}
      >
        <Users size={16} />
      </button>
      <button
        type="button"
        title={readStateReason ?? '标为已读'}
        aria-label="标为已读"
        disabled={Boolean(readStateReason)}
        onClick={onReadState}
      >
        <MailOpen size={16} />
      </button>
    </div>
  );
}
