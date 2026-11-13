import { TimeLabel } from './TimeLabel';
import { eventTimeFormatter } from '@weq/time';
import { Modal } from './Dialog';
import { useDraftCopies } from '../lib/draftPersistence';
import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Download, FileText, Trash2, X } from 'lucide-react';
import { LoadingIndicator } from './LoadingIndicator';
import { client, trpc } from '../trpc/client';
import { accountBinding, useClientPreferences } from '../lib/clientPreferences';
import { useAppDialog } from '../lib/dialogUtils';
import { useViewState } from '../state/view';
import '../styles/client-sync.css';

/** 副本值形如 `{ source, content, createdAt }`；其他形状按内容兜底。 */
function copyParts(value: unknown): { source: string; content: unknown; createdAt: number | null } {
  if (value && typeof value === 'object' && 'content' in value) {
    const record = value as { source?: unknown; content?: unknown; createdAt?: unknown };
    return {
      source: typeof record.source === 'string' ? record.source : '',
      content: record.content,
      createdAt: typeof record.createdAt === 'number' ? record.createdAt : null,
    };
  }
  return { source: '', content: value, createdAt: null };
}

/** 草稿正文只取人类可读的文本，结构化内容不直接抛 JSON 给用户。 */
function draftText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts = value
      .map((part) => draftText(part))
      .filter((part): part is string => Boolean(part));
    return parts.length ? parts.join('\n') : null;
  }
  if (value && typeof value === 'object') {
    const text = (value as { text?: unknown }).text;
    if (typeof text === 'string') return text;
  }
  return null;
}

function sourceLabel(source: string): string {
  if (source.startsWith('chat:c2c:')) return '单聊草稿';
  if (source.startsWith('chat:group:')) return '群聊草稿';
  if (source.startsWith('chat:')) return '聊天草稿';
  if (source.startsWith('assistant:')) return '助手草稿';
  if (source.startsWith('merge-forward:') || source.startsWith('mergeForward:'))
    return '合并转发草稿';
  if (source.startsWith('mail:')) return '邮件草稿';
  return source ? '其它草稿' : '未知来源';
}

function summaryOf(text: string | null): string {
  if (!text) return '这份副本没有可读文本正文。';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 90 ? `${flat.slice(0, 90)}…` : flat;
}

function timeLabel(createdAt: number | null): string {
  if (!createdAt) return '保存时间未知';
  return eventTimeFormatter.format(new Date(createdAt));
}

function DraftModal({
  title,
  id,
  onClose,
  children,
}: {
  title: string;
  id: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Modal labelledBy={id} onClose={onClose} centered width={560} className="weq-message-modal">
      <div className="weq-dialog weq-dialog-info">
        <div className="weq-dialog-head">
          <span className="weq-dialog-icon">
            <FileText size={20} aria-hidden />
          </span>
          <h3 id={id} className="weq-dialog-title">
            {title}
          </h3>
          <button type="button" className="weq-dialog-x" aria-label="关闭" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="weq-dialog-body">{children}</div>
      </div>
    </Modal>
  );
}

export function DraftCopiesHost() {
  useClientPreferences((state) => state.tick);
  const binding = accountBinding();
  const openedUin = useViewState((state) => state.openedUin);
  const [opened, setOpened] = useState(false);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [error, setError] = useState('');
  const dialog = useAppDialog();
  const utils = trpc.useUtils();
  const copies = trpc.clientState.draftCopies.useQuery(
    binding ?? { expectedAccountUin: '', expectedAccountConfigId: '' },
    { enabled: Boolean(binding) },
  );
  const copiesOpen = useDraftCopies((state) => state.copiesOpen);
  useEffect(() => {
    useDraftCopies.setState({ copiesCount: copies.data?.length ?? 0 });
  }, [copies.data]);
  useEffect(() => {
    if (copiesOpen) setOpened(true);
  }, [copiesOpen]);
  useEffect(() => {
    if (!opened) setExpandedKey(null);
  }, [opened]);
  const items = copies.data ?? [];
  return (
    <>
      {opened && (
        <DraftModal title="草稿副本" id="weq-draft-copies-title" onClose={() => setOpened(false)}>
          <p className="weq-draft-copies-desc">
            多人同时编辑同一份草稿时，WeQ 会把较早的内容自动保留成副本，正在编辑的草稿不受影响。
          </p>
          {!copies.data && copies.isFetching ? (
            <LoadingIndicator />
          ) : items.length ? (
            <div className="weq-draft-copies">
              {items.map((copy) => {
                const { source, content, createdAt } = copyParts(copy.value);
                const text = draftText(content);
                const size = text ? text.length : 0;
                const expanded = expandedKey === copy.key;
                return (
                  <article className="weq-draft-copy" key={copy.key}>
                    <header className="weq-draft-copy-head">
                      <strong>{sourceLabel(source)}</strong>
                      <time dateTime={createdAt ? new Date(createdAt).toISOString() : undefined}>
                        <TimeLabel value={createdAt || null} precision="millisecond">
                          {timeLabel(createdAt)}
                        </TimeLabel>
                      </time>
                    </header>
                    {expanded && text ? (
                      <pre className="weq-draft-copy-body" data-privacy-sensitive>
                        {text}
                      </pre>
                    ) : (
                      <p className="weq-draft-copy-summary">{summaryOf(text)}</p>
                    )}
                    <div className="weq-draft-copy-actions">
                      <button
                        type="button"
                        className="weq-set-btn weq-set-btn-soft"
                        aria-expanded={expanded}
                        onClick={() => setExpandedKey(expanded ? null : copy.key)}
                        disabled={!text}
                      >
                        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        {expanded ? '收起全文' : '查看全文'}
                      </button>
                      <button
                        type="button"
                        className="weq-set-btn weq-set-btn-soft"
                        onClick={() => {
                          const url = URL.createObjectURL(
                            new Blob([JSON.stringify(copy.value, null, 2)], {
                              type: 'application/json',
                            }),
                          );
                          const anchor = document.createElement('a');
                          anchor.href = url;
                          anchor.download = 'weq-draft-copy.json';
                          anchor.click();
                          setTimeout(() => URL.revokeObjectURL(url), 1000);
                        }}
                      >
                        <Download size={14} />
                        导出副本
                      </button>
                      <button
                        type="button"
                        className="weq-set-btn weq-set-btn-soft weq-draft-copy-delete"
                        onClick={async () => {
                          if (
                            !binding ||
                            !(await dialog.confirm(
                              '删除草稿副本',
                              '将删除这份副本，正在编辑的草稿和其他副本保持不变。',
                              { okLabel: '删除', tone: 'warning' },
                            ))
                          )
                            return;
                          try {
                            const result = await client.clientState.saveDraft.mutate({
                              ...binding,
                              key: copy.key,
                              value: null,
                              expectedVersion: copy.version,
                            });
                            if (!result.ok) throw new Error('副本已变化，请重新打开后重试');
                            setExpandedKey((key) => (key === copy.key ? null : key));
                            await utils.clientState.draftCopies.invalidate();
                          } catch (reason) {
                            setError(reason instanceof Error ? reason.message : String(reason));
                          }
                        }}
                      >
                        <Trash2 size={14} />
                        删除
                      </button>
                    </div>
                    {expanded && text ? (
                      <p className="weq-draft-copy-meta">共 {size} 个字符</p>
                    ) : null}
                  </article>
                );
              })}
            </div>
          ) : (
            <p className="weq-draft-copies-desc">
              还没有草稿副本。出现并发编辑时，旧内容会自动保留在这里。
            </p>
          )}
          {error ? (
            <div role="alert" className="weq-draft-copies-error">
              <p>操作没有完成，请重试。</p>
              <details>
                <summary>技术详情</summary>
                <pre>{error}</pre>
              </details>
            </div>
          ) : null}
          {!binding && openedUin ? (
            <p className="weq-draft-copies-desc">正在读取当前账号，稍后会自动加载副本。</p>
          ) : null}
        </DraftModal>
      )}
    </>
  );
}
