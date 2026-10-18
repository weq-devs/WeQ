import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Copy,
  Download,
  FilePlus2,
  FolderPlus,
  Forward,
  ListPlus,
  RotateCw,
  Share2,
  Trash2,
  X,
  ExternalLink,
  Loader2,
  Minus,
  Square,
  Copy as RestoreWindow,
} from 'lucide-react';
import { client, trpc } from '../../trpc/client';
import { IS_ELECTRON } from '../../lib/target';
import { RenderDocumentContext } from '../../lib/renderDocument';
import { useAppLock } from '../../state/lock';
import { copyTextToClipboard } from '../../im-template/template/clipboard';
import type { Message } from '../../im-template/template/types';
import { MergeForwardComposer } from './MergeForwardComposer';
import { MergeForwardTargets } from './MergeForwardTargets';
import { SequentialForwardDialog } from '../SequentialForwardDialog';
import { Modal } from '../Dialog';
import { useToast } from '../Toast';
import { COMPOSITION_DISPOSE_EVENT } from '../../hooks/useCompositionWindow';
import {
  backupComposition,
  acknowledgeCompositionBackup,
  readCompositionBackups,
} from './workspaceRecovery';
import {
  coerceDraft,
  createEmptyDraft,
  draftTitle,
  mfId,
  validateDraft,
  segHasContent,
  isNestedContent,
  type MfDraft,
  type MfTarget,
} from './model';
import type { MfPerson } from './SenderPicker';
import {
  appendCompositionNodes,
  compositionMessages,
  compositionText,
  COMPOSITION_DRAG_TYPE,
  compositionRecords,
  insertCompositionEntry,
  compositionInsertionError,
  type CompositionBinding,
  type CompositionRequest,
} from './workspaceModel';
import '../../styles/composition-workspace.css';

type ArchiveKind = 'material' | 'history';
interface SendRequest {
  draft: MfDraft;
  mode: 'merged' | 'sequential';
}

export function CompositionWorkspace({
  popup,
  fallback,
  onClose,
  onPopOut,
  self,
  targets,
  sendAvailable,
  incoming,
  onRequestsHandled,
  onForward,
  onSend,
}: {
  popup: Window | null;
  fallback: boolean;
  onClose: () => void;
  onPopOut: () => void;
  self: MfPerson;
  targets: MfTarget[];
  sendAvailable: boolean;
  incoming?: readonly CompositionRequest[];
  onRequestsHandled?: (ids: string[]) => void;
  onForward: (draft: MfDraft, target: MfTarget, binding: CompositionBinding) => Promise<void>;
  onSend: (
    message: Message,
    target: MfTarget,
    signal: AbortSignal,
    binding: CompositionBinding,
  ) => Promise<void>;
}) {
  const locked = useAppLock((state) => state.locked);
  const visible = Boolean(popup || fallback) && !locked;
  useEffect(() => {
    if (locked && (popup || fallback)) onClose();
  }, [locked, popup, fallback, onClose]);
  const ownerDocument = popup?.document ?? document;
  const config = trpc.account.getAccountConfig.useQuery(undefined, {
    enabled: visible,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  });
  const [binding, setBinding] = useState<CompositionBinding | null>(null);
  useEffect(() => {
    if (
      visible &&
      !binding &&
      !config.isFetching &&
      config.data?.uin === self.uin &&
      config.data.configId
    )
      setBinding({ expectedAccountUin: self.uin, expectedAccountConfigId: config.data.configId });
  }, [visible, binding, config.data, config.isFetching, self.uin]);
  const bound = binding ?? { expectedAccountUin: self.uin, expectedAccountConfigId: '' };
  const [kind, setKind] = useState<ArchiveKind>('history');
  const entries = trpc.mergeForward.archiveList.useQuery(
    { ...bound, kind },
    { enabled: visible && Boolean(binding), refetchOnWindowFocus: false },
  );
  const saved = trpc.mergeForward.workspaceDrafts.useQuery(bound, {
    enabled: visible && Boolean(binding),
    refetchOnWindowFocus: false,
  });
  const history = trpc.mergeForward.archiveList.useQuery(
    { ...bound, kind: 'history' },
    { enabled: visible && Boolean(binding), refetchOnWindowFocus: false },
  );
  const [draft, setDraft] = useState<MfDraft>(createEmptyDraft);
  const [progress, setProgress] = useState<MfDraft | null>(null);
  const progressRef = useRef<MfDraft | null>(null);
  const working = progress ?? draft;
  const [recoveries, setRecoveries] = useState<MfDraft[]>([]);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!IS_ELECTRON || !window.electron) return;
    return window.electron.ipcRenderer.on('composition:state', (_event, value: unknown) => {
      if (
        value &&
        typeof value === 'object' &&
        'maximized' in value &&
        typeof value.maximized === 'boolean'
      )
        setMaximized(value.maximized);
    });
  }, []);
  const [dirty, setDirty] = useState(false);
  const [persisted, setPersisted] = useState(false);
  const [editorVersion, setEditorVersion] = useState(0);
  const [dragged, setDragged] = useState<{ id: string; kind: ArchiveKind } | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const [send, setSend] = useState<SendRequest | null>(null);
  const [selected, setSelected] = useState(new Set<string>());
  const accepted = useRef(new Set<string>());
  const seenRequests = useRef(new Set<string>());
  const serial = useRef(Promise.resolve());
  const version = useRef(0);
  const dirtyRef = useRef(false);
  const disposing = useRef(false);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const pushToast = useToast((state) => state.push);
  const onProgress = useCallback((value: MfDraft | null) => {
    if (value || progressRef.current) {
      dirtyRef.current = true;
      version.current += 1;
      setDirty(true);
    }
    progressRef.current = value;
    setProgress(value);
  }, []);
  useEffect(() => {
    if (!visible && progressRef.current) {
      setDraft(progressRef.current);
      progressRef.current = null;
      setProgress(null);
    }
  }, [visible]);
  useEffect(() => {
    if (!binding) return;
    try {
      const result = readCompositionBackups(binding);
      setRecoveries(result.drafts);
      if (result.damaged) setError(`${result.damaged} 份本机草稿备份损坏，原备份已保留`);
    } catch (cause) {
      setError(`无法读取本机草稿备份：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }, [binding]);
  useLayoutEffect(() => {
    if (!dirty || !binding) return;
    try {
      backupComposition(binding, working);
    } catch (cause) {
      setError(`本机草稿备份不可用：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }, [binding, dirty, working]);
  const change = (next: MfDraft) => {
    dirtyRef.current = true;
    version.current += 1;
    setDraft({ ...next, updatedAt: Math.floor(Date.now() / 1000) });
    setDirty(true);
    setError('');
  };
  useEffect(() => {
    const handled: string[] = [];
    for (const request of incoming ?? []) {
      if (seenRequests.current.has(request.id)) continue;
      seenRequests.current.add(request.id);
      handled.push(request.id);
      if (request.pending) {
        setStatus('正在读取所选消息…');
        continue;
      }
      if (request.error) {
        setError(request.error);
        continue;
      }
      setError('');
      setStatus(`已添加 ${request.draft.nodes.length} 条消息`);
      dirtyRef.current = true;
      version.current += 1;
      setDraft((current) => appendCompositionNodes(current, request.draft.nodes));
      setDirty(true);
    }
    if (handled.length) onRequestsHandled?.(handled);
  }, [incoming, onRequestsHandled]);

  const persist = async (snapshot: MfDraft, identity: CompositionBinding) => {
    const revision = version.current;
    const job = serial.current
      .catch(() => {})
      .then(async () => {
        await client.mergeForward.workspaceSave.mutate({ ...identity, draft: snapshot });
      });
    serial.current = job;
    await job;
    if (revision === version.current) {
      try {
        acknowledgeCompositionBackup(identity, snapshot);
        setRecoveries(readCompositionBackups(identity).drafts);
      } catch (cause) {
        setError(
          `记录已保存，但本机备份未清理：${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
      dirtyRef.current = false;
      setDirty(false);
      setPersisted(true);
      setStatus('已自动保存');
    }
    void saved.refetch();
  };
  const persistRef = useRef(persist);
  persistRef.current = persist;
  useEffect(() => {
    if (!dirty || !binding) return;
    const revision = version.current;
    const timer = window.setTimeout(() => {
      if (!dirtyRef.current || revision !== version.current) return;
      void persistRef.current(structuredClone(working), binding).catch((cause) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(`记录未保存：${message}`);
        pushToast({ tone: 'error', title: '合成记录未保存', detail: message });
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [working, dirty, binding, pushToast]);
  useEffect(() => {
    if (!popup) return;
    disposing.current = false;
    const guard = (event: BeforeUnloadEvent) => {
      if (disposing.current || !dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    popup.addEventListener('beforeunload', guard);
    const dispose = () => {
      disposing.current = true;
    };
    popup.addEventListener(COMPOSITION_DISPOSE_EVENT, dispose);
    return () => {
      popup.removeEventListener('beforeunload', guard);
      popup.removeEventListener(COMPOSITION_DISPOSE_EVENT, dispose);
    };
  }, [popup]);

  const perform = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const archive = async (value = working) => {
    if (!binding) throw new Error('正在核对合成窗口账号');
    if (!value.nodes.some((node) => node.segs.some(segHasContent)))
      throw new Error('没有可保存的消息内容');
    const result = await client.mergeForward.archiveAppend.mutate({
      ...binding,
      kind: 'material',
      draft: value,
    });
    if (kind === 'material') await entries.refetch();
    setStatus('素材已保存');
    return coerceDraft(result);
  };
  const replace = async (value: MfDraft, duplicate = false) => {
    if (!binding) return;
    if (dirty) await persist(structuredClone(working), binding);
    if (dirtyRef.current) throw new Error('内容仍在更新，请稍后再切换记录');
    progressRef.current = null;
    setProgress(null);
    setEditorVersion((current) => current + 1);
    change(
      duplicate
        ? { ...structuredClone(value), id: mfId('draft'), createdAt: Math.floor(Date.now() / 1000) }
        : structuredClone(value),
    );
    setPersisted(false);
    setKind('history');
  };
  const copy = async (value: MfDraft) => {
    if (!(await copyTextToClipboard(compositionText(value), ownerDocument)))
      throw new Error('剪贴板不可用');
    setStatus('已复制文本');
  };
  const download = (value: MfDraft) => {
    const url = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify(
            {
              format: 'weq-composition',
              version: 1,
              origin: 'local-composition',
              media: 'local-path-references',
              draft: value,
            },
            null,
            2,
          ),
        ],
        { type: 'application/json' },
      ),
    );
    const anchor = ownerDocument.createElement('a');
    anchor.href = url;
    anchor.download = `${(value.title || draftTitle(value.nodes)).replace(/[\\/:*?"<>|]/g, '_') || '合成记录'}.json`;
    ownerDocument.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const requestSend = async (value: MfDraft, mode: SendRequest['mode']) => {
    const problem = validateDraft(value);
    if (problem) throw new Error(problem);
    if (binding && value.id === working.id) await persist(structuredClone(value), binding);
    const snapshot = structuredClone(value);
    setSelected(new Set());
    accepted.current.clear();
    setSend({ draft: snapshot, mode });
  };
  const sendMerged = async () => {
    if (!send || !binding) return;
    for (const target of targets.filter((target) => selected.has(target.id))) {
      if (!visibleRef.current || popup?.closed) throw new Error('合成窗口已关闭，已停止后续发送');
      if (accepted.current.has(target.id)) continue;
      await onForward(send.draft, target, binding);
      accepted.current.add(target.id);
    }
    setSend(null);
    setStatus('已发送');
  };
  const records = compositionRecords(
    [working],
    recoveries,
    (saved.data?.current ?? []).map(coerceDraft),
    (saved.data?.legacy ?? []).map(coerceDraft),
    (history.data ?? []).map(coerceDraft),
  );
  const library = kind === 'material' ? (entries.data ?? []).map(coerceDraft) : records;
  const insert = (
    entry: MfDraft,
    sourceKind: ArchiveKind,
    at = working.nodes.length,
    flatten = false,
  ) => {
    const next = insertCompositionEntry(working, entry, sourceKind, at, flatten);
    progressRef.current = null;
    setProgress(null);
    setEditorVersion((current) => current + 1);
    change(next);
  };
  const draggedEntry = dragged
    ? library.find((entry) => entry.id === dragged.id && dragged.kind === kind)
    : undefined;
  const canDrop =
    !busy && draggedEntry !== undefined && !compositionInsertionError(working, draggedEntry, kind);
  if (!visible) return null;
  const content = (
    <RenderDocumentContext.Provider value={ownerDocument}>
      <section
        className={`weq-composition-workspace${fallback ? ' is-fallback' : ''}`}
        aria-label="合成聊天记录"
      >
        <header className="weq-composition-head">
          <strong>合成聊天记录</strong>
          <span>本地合成</span>
          <span className="weq-composition-spacer" />
          {IS_ELECTRON ? (
            <>
              <button
                type="button"
                title="最小化合成窗口"
                aria-label="最小化合成窗口"
                onClick={() => window.electron?.ipcRenderer.send('composition:control', 'minimize')}
              >
                <Minus size={16} />
              </button>
              <button
                type="button"
                title={maximized ? '还原合成窗口' : '最大化合成窗口'}
                aria-label={maximized ? '还原合成窗口' : '最大化合成窗口'}
                onClick={() =>
                  window.electron?.ipcRenderer.send('composition:control', 'toggle-maximize')
                }
              >
                {maximized ? <RestoreWindow size={15} /> : <Square size={15} />}
              </button>
            </>
          ) : null}
          {fallback ? (
            <button type="button" title="打开独立窗口" aria-label="打开独立窗口" onClick={onPopOut}>
              <ExternalLink size={18} />
            </button>
          ) : null}
          <button
            type="button"
            title="关闭合成窗口"
            aria-label="关闭合成窗口"
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                if (dirty && binding) await persist(structuredClone(working), binding);
                if (dirtyRef.current) throw new Error('内容仍在更新，请稍后再关闭');
                setDraft(working);
                progressRef.current = null;
                setProgress(null);
                onClose();
              })
            }
          >
            <X size={18} />
          </button>
        </header>
        {!binding || config.isError ? (
          <div className="weq-composition-error" role={config.isError ? 'alert' : 'status'}>
            {config.isError ? config.error.message : '正在读取当前账号…'}
          </div>
        ) : (
          <div className="weq-composition-columns">
            <aside className="weq-composition-library">
              <div className="weq-composition-tabs" role="tablist" aria-label="合成资料">
                {(['history', 'material'] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="tab"
                    aria-selected={kind === value}
                    onClick={() => setKind(value)}
                  >
                    {value === 'material' ? '素材库' : '合成记录'}
                  </button>
                ))}
                <span className="weq-composition-spacer" />
                <button
                  type="button"
                  title="新建合成记录"
                  aria-label="新建合成记录"
                  disabled={busy}
                  onClick={() => void perform(() => replace(createEmptyDraft()))}
                >
                  <FilePlus2 size={17} />
                </button>
              </div>
              <div
                className="weq-composition-entries"
                role="tabpanel"
                aria-label={kind === 'material' ? '素材库' : '合成记录'}
              >
                {entries.isError || (kind === 'history' && (saved.isError || history.isError)) ? (
                  <p role="alert">
                    {entries.error?.message || saved.error?.message || history.error?.message}
                    <button
                      type="button"
                      onClick={() => {
                        void entries.refetch();
                        void saved.refetch();
                        void history.refetch();
                      }}
                    >
                      重试
                    </button>
                  </p>
                ) : entries.isLoading ||
                  (kind === 'history' && (saved.isLoading || history.isLoading)) ? (
                  <p role="status">加载中…</p>
                ) : !library.length ? (
                  <p className="weq-composition-empty">
                    {kind === 'material' ? '暂无素材' : '暂无合成记录'}
                  </p>
                ) : (
                  library.map((entry) => {
                    return (
                      <article
                        key={entry.id}
                        className={`weq-composition-entry${kind === 'history' && entry.id === draft.id ? ' is-selected' : ''}`}
                        draggable={!busy}
                        onDragStart={(event) => {
                          event.dataTransfer.setData(
                            COMPOSITION_DRAG_TYPE,
                            JSON.stringify({ id: entry.id, kind }),
                          );
                          event.dataTransfer.effectAllowed = 'copy';
                          setDragged({ id: entry.id, kind });
                        }}
                        onDragEnd={() => {
                          setDragged(null);
                          setDropAt(null);
                        }}
                      >
                        <button
                          type="button"
                          className="weq-composition-entry-title"
                          aria-current={
                            kind === 'history' && entry.id === draft.id ? 'true' : undefined
                          }
                          disabled={busy}
                          onClick={() => {
                            if (kind === 'history' && entry.id !== draft.id)
                              void perform(() => replace(entry));
                            else if (kind === 'material')
                              void perform(async () => insert(entry, kind));
                          }}
                        >
                          {entry.title || draftTitle(entry.nodes)}
                        </button>
                        <span>
                          {entry.nodes.length} 条 ·{' '}
                          {new Intl.DateTimeFormat('zh-CN', {
                            timeZone: 'Asia/Shanghai',
                            dateStyle: 'short',
                            timeStyle: 'short',
                          }).format(new Date(entry.updatedAt * 1000))}
                        </span>
                        <p>{compositionText(entry)}</p>
                        <div className="weq-composition-entry-actions">
                          <button
                            type="button"
                            title={kind === 'history' ? '嵌套插入当前合成' : '添加到当前合成'}
                            aria-label={kind === 'history' ? '嵌套插入当前合成' : '添加到当前合成'}
                            disabled={busy || entry.id === draft.id}
                            onClick={() => void perform(async () => insert(entry, kind))}
                          >
                            <FolderPlus size={16} />
                          </button>
                          {kind === 'history' ? (
                            <button
                              type="button"
                              title="展开插入当前合成"
                              aria-label="展开插入当前合成"
                              disabled={busy || entry.id === draft.id}
                              onClick={() =>
                                void perform(async () =>
                                  insert(entry, kind, working.nodes.length, true),
                                )
                              }
                            >
                              <ListPlus size={16} />
                            </button>
                          ) : null}
                          <button
                            type="button"
                            title="创建副本"
                            aria-label="创建副本"
                            disabled={busy}
                            onClick={() => void perform(() => replace(entry, true))}
                          >
                            <FilePlus2 size={16} />
                          </button>
                          <button
                            type="button"
                            title="复制文本"
                            aria-label="复制文本"
                            onClick={() => void perform(() => copy(entry))}
                          >
                            <Copy size={16} />
                          </button>
                          <button
                            type="button"
                            title="导出 JSON（媒体引用本机文件）"
                            aria-label="导出 JSON"
                            onClick={() => download(entry)}
                          >
                            <Download size={16} />
                          </button>
                          <button
                            type="button"
                            title="逐条发送"
                            aria-label="逐条发送"
                            disabled={!sendAvailable || busy}
                            onClick={() => void perform(() => requestSend(entry, 'sequential'))}
                          >
                            <Forward size={16} />
                          </button>
                          <button
                            type="button"
                            title="合并转发"
                            aria-label="合并转发"
                            disabled={!sendAvailable || busy}
                            onClick={() => void perform(() => requestSend(entry, 'merged'))}
                          >
                            <Share2 size={16} />
                          </button>
                          <button
                            type="button"
                            title={kind === 'history' ? '删除合成记录' : '删除素材'}
                            aria-label={kind === 'history' ? '删除合成记录' : '删除素材'}
                            disabled={busy}
                            onClick={() =>
                              void perform(async () => {
                                if (kind === 'history') {
                                  if (dirtyRef.current)
                                    await persist(structuredClone(working), binding);
                                  if (dirtyRef.current)
                                    throw new Error('内容仍在更新，请稍后再删除');
                                  await serial.current.catch(() => {});
                                  await client.mergeForward.workspaceRemove.mutate({
                                    ...binding,
                                    id: entry.id,
                                  });
                                  acknowledgeCompositionBackup(binding, entry);
                                  setRecoveries(readCompositionBackups(binding).drafts);
                                  if (entry.id === draft.id) {
                                    progressRef.current = null;
                                    setProgress(null);
                                    setDraft(createEmptyDraft());
                                    setPersisted(false);
                                  }
                                  await saved.refetch();
                                  await history.refetch();
                                } else
                                  await client.mergeForward.archiveRemove.mutate({
                                    ...binding,
                                    kind,
                                    id: entry.id,
                                  });
                                await entries.refetch();
                              })
                            }
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </article>
                    );
                  })
                )}
              </div>
            </aside>
            <main
              className={`weq-composition-editor${dragged ? (canDrop ? ' is-drop-target' : ' is-drop-forbidden') : ''}`}
              onDragOver={(event) => {
                if (event.dataTransfer.types.includes(COMPOSITION_DRAG_TYPE)) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = canDrop ? 'copy' : 'none';
                  if (!canDrop) {
                    setDropAt(null);
                    return;
                  }
                  const slot = (event.target as HTMLElement).closest<HTMLElement>(
                    '[data-composition-index]',
                  );
                  const rect = slot?.getBoundingClientRect();
                  setDropAt(
                    slot && rect
                      ? Number(slot.dataset.compositionIndex) +
                          (event.clientY > rect.top + rect.height / 2 ? 1 : 0)
                      : working.nodes.length,
                  );
                }
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                  setDropAt(null);
              }}
              onDrop={(event) => {
                const text = event.dataTransfer.getData(COMPOSITION_DRAG_TYPE);
                if (!text) return;
                event.preventDefault();
                try {
                  const data: unknown = JSON.parse(text);
                  if (
                    !data ||
                    typeof data !== 'object' ||
                    !('id' in data) ||
                    !('kind' in data) ||
                    data.kind !== kind
                  )
                    throw new Error('素材来源已变化');
                  if (busy) throw new Error('当前操作尚未完成');
                  const entry = library.find((item) => item.id === data.id);
                  if (!entry) throw new Error('素材已不存在');
                  insert(entry, kind, dropAt ?? working.nodes.length);
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : String(cause));
                } finally {
                  setDropAt(null);
                  setDragged(null);
                }
              }}
            >
              <input
                className="weq-composition-title"
                aria-label="聊天记录标题"
                placeholder={draftTitle(draft.nodes)}
                value={draft.title}
                disabled={busy}
                onChange={(event) => change({ ...draft, title: event.target.value })}
              />
              <div className="weq-composition-canvas" inert={busy}>
                <MergeForwardComposer
                  key={`${draft.id}:${editorVersion}`}
                  draft={draft}
                  onChange={change}
                  onProgress={onProgress}
                  self={self}
                  senderMode="global"
                  dropAt={dropAt}
                />
              </div>
              <footer className="weq-composition-actions">
                <span>
                  {working.nodes.length} 条 · {dirty ? '未保存' : persisted ? '已保存' : '新记录'}
                </span>
                <button
                  type="button"
                  title="保存到素材库"
                  aria-label="保存到素材库"
                  disabled={busy || !working.nodes.length}
                  onClick={() =>
                    void perform(async () => {
                      await archive();
                    })
                  }
                >
                  <FolderPlus size={17} />
                </button>
                <button
                  type="button"
                  title="复制文本"
                  aria-label="复制当前合成文本"
                  disabled={!working.nodes.length}
                  onClick={() => void perform(() => copy(working))}
                >
                  <Copy size={17} />
                </button>
                <button
                  type="button"
                  title="导出 JSON（媒体引用本机文件）"
                  aria-label="导出当前合成 JSON"
                  onClick={() => download(working)}
                >
                  <Download size={17} />
                </button>
                <button
                  type="button"
                  title="逐条发送"
                  aria-label="逐条发送当前合成"
                  disabled={!sendAvailable || busy || !working.nodes.length}
                  onClick={() => void perform(() => requestSend(working, 'sequential'))}
                >
                  <Forward size={17} />
                </button>
                <button
                  type="button"
                  title="合并转发"
                  aria-label="合并转发当前合成"
                  disabled={!sendAvailable || busy || !working.nodes.length}
                  onClick={() => void perform(() => requestSend(working, 'merged'))}
                >
                  <Share2 size={17} />
                </button>
              </footer>
            </main>
          </div>
        )}
        <div className="weq-composition-status" role={error ? 'alert' : 'status'}>
          {busy ? <Loader2 size={15} className="spin" /> : null}
          {error || status}
          {error && dirty && binding ? (
            <button
              type="button"
              title="重试保存"
              aria-label="重试保存"
              disabled={busy}
              onClick={() => void perform(() => persist(structuredClone(working), binding))}
            >
              <RotateCw size={15} />
            </button>
          ) : null}
        </div>
      </section>
      {send?.mode === 'sequential' ? (
        <SequentialForwardDialog
          messages={compositionMessages(send.draft)}
          targets={targets}
          onSend={async (message, target, signal) => {
            if (!binding) throw new Error('合成窗口账号不可用');
            const node = send.draft.nodes.find((item) => item.id === message.id);
            if (node && isNestedContent(node.segs)) {
              signal.throwIfAborted();
              if (!visibleRef.current || popup?.closed) throw new Error('合成窗口已关闭');
              await onForward(
                {
                  ...send.draft,
                  nodes: node.segs.flatMap((segment) =>
                    segment.t === 'node'
                      ? [
                          {
                            id: segment.id,
                            sender: { uid: '', uin: segment.userUin, name: segment.nickname },
                            time: segment.time,
                            segs: segment.segs,
                            ...(segment.decoration ? { decoration: segment.decoration } : {}),
                            ...(segment.sourceCompositionId
                              ? { sourceCompositionId: segment.sourceCompositionId }
                              : {}),
                          },
                        ]
                      : [],
                  ),
                },
                target,
                binding,
              );
              return;
            }
            await onSend(message, target, signal, binding);
          }}
          onClose={() => setSend(null)}
        />
      ) : send ? (
        <Modal onClose={busy ? undefined : () => setSend(null)} width={480}>
          <section className="weq-composition-send">
            <header>
              <strong>合并转发</strong>
              <button
                type="button"
                title="关闭"
                aria-label="关闭发送目标"
                disabled={busy}
                onClick={() => setSend(null)}
              >
                <X size={17} />
              </button>
            </header>
            <MergeForwardTargets targets={targets} selected={selected} onChange={setSelected} />
            {error ? <p role="alert">{error}</p> : null}
            <button
              type="button"
              className="weq-action-primary"
              disabled={busy || !selected.size}
              onClick={() => void perform(sendMerged)}
            >
              <Share2 size={17} />
              发送
            </button>
          </section>
        </Modal>
      ) : null}
    </RenderDocumentContext.Provider>
  );
  return popup ? createPortal(content, popup.document.body) : content;
}
