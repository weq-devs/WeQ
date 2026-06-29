/**
 * 助手报告附件卡片：展示 write_report 写出的本地文件（标题 / 类型 / 大小），
 * 提供「查看」「另存为」。查看 HTML → 主进程开隔离窗口用本地 Tailwind 渲染；
 * markdown/text → 系统默认程序打开。另存为 → 保存对话框复制到用户选定位置。
 */

import { useState, type ReactElement } from 'react';
import { Download, Eye, FileCode2, FileText, FileType2 } from 'lucide-react';
import type { AssistantArtifact } from '@weq/service';
import { trpc } from '../../trpc/client';
import { useAppDialog } from '../../lib/dialogUtils';

function kindIcon(kind: AssistantArtifact['kind']): ReactElement {
  if (kind === 'html') return <FileCode2 size={18} />;
  if (kind === 'markdown') return <FileType2 size={18} />;
  return <FileText size={18} />;
}

function kindLabel(kind: AssistantArtifact['kind']): string {
  if (kind === 'html') return 'HTML 报告';
  if (kind === 'markdown') return 'Markdown';
  return '文本';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function AssistantArtifactCard({ artifact }: { artifact: AssistantArtifact }): ReactElement {
  const dialog = useAppDialog();
  const open = trpc.account.openAssistantArtifact.useMutation();
  const save = trpc.account.saveAssistantArtifact.useMutation();
  const [busy, setBusy] = useState<'view' | 'save' | null>(null);

  async function onView(): Promise<void> {
    setBusy('view');
    try {
      await open.mutateAsync({ id: artifact.id });
    } catch (e) {
      dialog.error('打开失败', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onSave(): Promise<void> {
    setBusy('save');
    try {
      await save.mutateAsync({ id: artifact.id, name: artifact.name });
    } catch (e) {
      dialog.error('另存为失败', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="weq-asst-artifact">
      <span className="weq-asst-artifact-icon">{kindIcon(artifact.kind)}</span>
      <div className="weq-asst-artifact-meta">
        <span className="weq-asst-artifact-name" title={artifact.name}>{artifact.name}</span>
        <span className="weq-asst-artifact-sub">
          {kindLabel(artifact.kind)} · {formatBytes(artifact.bytes)}
        </span>
      </div>
      <div className="weq-asst-artifact-actions">
        <button
          type="button"
          className="weq-set-btn weq-set-btn-sm"
          disabled={busy !== null}
          onClick={() => void onView()}
        >
          <Eye size={13} /> 查看
        </button>
        <button
          type="button"
          className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
          disabled={busy !== null}
          onClick={() => void onSave()}
        >
          <Download size={13} /> 另存为
        </button>
      </div>
    </div>
  );
}
