import { CloudDownload, Download, Users, MailOpen, Trash2 } from 'lucide-react';
import type { ConversationBatchAction } from '../lib/conversationViews';
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
  actions = ['export', 'roaming', 'roster', 'read'],
  deleteReason,
  onDelete,
}: {
  exportReason?: string;
  roamingReason?: string;
  rosterReason?: string;
  readStateReason?: string;
  onExport: () => void;
  onRoaming: () => void;
  onRoster: () => void;
  onReadState: () => void;
  actions?: readonly ConversationBatchAction[];
  deleteReason?: string;
  onDelete?: () => void;
}) {
  return (
    <div className="weq-conversation-selection-toolbar" role="toolbar" aria-label="会话多选操作">
      {actions.includes('roaming') && (
        <button
          type="button"
          title={roamingReason ?? '拉取所选会话漫游消息'}
          aria-label="拉取所选会话漫游消息"
          disabled={Boolean(roamingReason)}
          onClick={onRoaming}
        >
          <CloudDownload size={16} />
        </button>
      )}
      {actions.includes('export') && (
        <button
          type="button"
          title={exportReason ?? '导出所选会话'}
          aria-label="导出所选会话"
          disabled={Boolean(exportReason)}
          onClick={onExport}
        >
          <Download size={16} />
        </button>
      )}
      {actions.includes('roster') && (
        <button
          type="button"
          title={rosterReason ?? '导出名单'}
          aria-label="导出名单"
          disabled={Boolean(rosterReason)}
          onClick={onRoster}
        >
          <Users size={16} />
        </button>
      )}
      {actions.includes('read') && (
        <button
          type="button"
          title={readStateReason ?? '标为已读'}
          aria-label="标为已读"
          disabled={Boolean(readStateReason)}
          onClick={onReadState}
        >
          <MailOpen size={16} />
        </button>
      )}
      {actions.includes('delete') && (
        <button
          type="button"
          title={deleteReason ?? '永久删除所选 AI 会话'}
          aria-label="永久删除所选 AI 会话"
          disabled={Boolean(deleteReason)}
          onClick={onDelete}
        >
          <Trash2 size={16} />
        </button>
      )}
    </div>
  );
}
