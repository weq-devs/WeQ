import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  Bell,
  ChevronLeft,
  ChevronRight,
  Download,
  FilePenLine,
  Folder,
  Forward,
  Inbox,
  LoaderCircle,
  Mail,
  MailOpen,
  Paperclip,
  PenLine,
  Power,
  RefreshCw,
  Reply,
  ReplyAll,
  Search,
  Send,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import type {
  MailAction,
  MailDetail,
  MailFolder,
  MailPage as MailPageData,
  MailStatus,
  MailSummary,
} from '@weq/service/mail';
import { SYSTEM_MAIL_FOLDERS } from '@weq/service/mail-wire';
import { useDialog } from '../../components/Dialog';
import { useToast } from '../../components/Toast';
import { usePrivacyStore } from '../../state/privacy';
import type { MailApi } from './api';
import { MailBody } from './MailBody';
import { MailComposer } from './MailComposer';
import {
  addressText,
  draftFromMail,
  formatMailSize,
  formatMailTime,
  mailError,
  newMailDraft,
  plainMailText,
  type MailDraft,
} from './content';
import '../../styles/mail.css';

const initialStatus: MailStatus = {
  state: 'disconnected',
  unread: 0,
  notifications: false,
  lastSync: null,
  error: null,
};
const emptyPage: MailPageData = { items: [], page: 0, total: 0, unread: 0, hasMore: false };
function folderIcon(id: number) {
  return id === 1
    ? Inbox
    : id === 2
      ? Star
      : id === 3
        ? Send
        : id === 4
          ? FilePenLine
          : id === 5
            ? Trash2
            : Folder;
}

export function MailPage({
  api,
  selfEmail,
  active = true,
  onUnreadChange,
  onOpenRequested,
  searchTarget,
}: {
  api: MailApi;
  selfEmail: string;
  active?: boolean;
  onUnreadChange?: (unread: number) => void;
  onOpenRequested?: () => void;
  searchTarget?: { id: string; folderId: number; revision: string } | null;
}) {
  const [status, setStatus] = useState(initialStatus);
  const [folders, setFolders] = useState<MailFolder[]>([...SYSTEM_MAIL_FOLDERS]);
  const [folderId, setFolderId] = useState(1),
    [pageNumber, setPageNumber] = useState(0);
  const [unreadOnly, setUnreadOnly] = useState(false),
    [query, setQuery] = useState(''),
    [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(emptyPage),
    [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null),
    [detail, setDetail] = useState<MailDetail | null>(null),
    [reading, setReading] = useState(false);
  const [threadRoot, setThreadRoot] = useState<string | null>(null);
  const [checked, setChecked] = useState<string[]>([]),
    [actionBusy, setActionBusy] = useState(false);
  const [draft, setDraft] = useState<MailDraft | null>(null),
    [showCompose, setShowCompose] = useState(false),
    [composeBusy, setComposeBusy] = useState(false),
    [composeDirty, setComposeDirty] = useState(false);
  const [revision, setRevision] = useState(0),
    [error, setError] = useState('');
  const [downloading, setDownloading] = useState<string | null>(null);
  const download = useRef<AbortController | null>(null),
    mounted = useRef(true),
    visible = useRef(active),
    composeVisible = useRef(showCompose);
  const loadSequence = useRef(0),
    readSequence = useRef(0);
  const openRequested = useRef(onOpenRequested);
  openRequested.current = onOpenRequested;
  visible.current = active;
  composeVisible.current = showCompose;
  const ready = status.state === 'ready';
  const selectedFolder = folders.find((item) => item.id === folderId);
  const selection = checked.length ? checked : selectedId ? [selectedId] : [];
  const chooseFolder = useCallback((id: number): void => {
    setThreadRoot(null);
    setPage(emptyPage);
    setFolderId(id);
    setPageNumber(0);
    setSelectedId(null);
    setDetail(null);
    setChecked([]);
    setKeyword('');
    setQuery('');
    setShowCompose(false);
    // 重选当前文件夹时查询参数不变，也必须显式重新读取列表。
    setRevision((value) => value + 1);
  }, []);
  const handledSearch = useRef('');
  const [searchReadRevision, setSearchReadRevision] = useState(0);
  const currentSearch = useRef(searchTarget);
  currentSearch.current = searchTarget;
  useEffect(() => {
    if (!active || !ready || !searchTarget || handledSearch.current === searchTarget.revision)
      return;
    handledSearch.current = searchTarget.revision;
    void (async () => {
      if (
        showCompose &&
        composeDirty &&
        !(await useDialog
          .getState()
          .confirm('打开搜索命中的邮件？', '当前写信内容尚未保存，确认后将退出写信。', {
            okLabel: '打开邮件',
            tone: 'warning',
          }))
      )
        return;
      if (!mounted.current || currentSearch.current?.revision !== searchTarget.revision) return;
      chooseFolder(searchTarget.folderId);
      setSelectedId(searchTarget.id);
      setSearchReadRevision((value) => value + 1);
    })();
  }, [active, ready, searchTarget, chooseFolder, showCompose, composeDirty]);

  const connect = useCallback(async () => {
    setError('');
    setStatus((current) => ({ ...current, state: 'connecting' }));
    try {
      const value = await api.connect();
      if (mounted.current) {
        setStatus(value);
        setRevision((current) => current + 1);
      }
    } catch (error) {
      if (mounted.current) {
        setStatus((current) => ({ ...current, state: 'error' }));
        setError(mailError(error));
      }
    }
  }, [api]);

  useEffect(() => {
    let alive = true;
    mounted.current = true;
    const unsubscribe = api.subscribe((event) => {
      if (!alive) return;
      if (event.type === 'open') {
        openRequested.current?.();
        if (event.notice) {
          chooseFolder(event.notice.folderId);
          setSelectedId(event.notice.id);
        }
      }
      if (event.type === 'status' && event.status) setStatus(event.status);
      if (event.type !== 'status' && visible.current) setRevision((current) => current + 1);
      if (event.type === 'new-mail' && event.notice)
        useToast.getState().push({
          tone: 'info',
          title: '收到新邮件',
          detail: usePrivacyStore.getState().enabled
            ? undefined
            : `${event.notice.sender}${event.notice.subject ? `：${event.notice.subject}` : ''}`,
        });
    });
    void api
      .status()
      .then((value) => {
        if (!alive) return;
        if (value.state === 'ready') setStatus(value);
        else void connect();
      })
      .catch((error) => {
        if (alive) setError(mailError(error));
      });
    return () => {
      alive = false;
      mounted.current = false;
      unsubscribe();
      api.dispose();
      download.current?.abort();
    };
  }, [api, connect, chooseFolder]);
  useEffect(() => {
    onUnreadChange?.(status.unread);
  }, [onUnreadChange, status.unread]);

  useEffect(() => {
    if (!ready || !active) return;
    const controller = new AbortController(),
      sequence = ++loadSequence.current;
    setLoading(true);
    setError('');
    void api
      .list(
        { folderId, page: pageNumber, unreadOnly, keyword: keyword || undefined },
        controller.signal,
      )
      .then((value) => {
        if (!controller.signal.aborted && sequence === loadSequence.current) setPage(value);
      })
      .catch((error) => {
        if (!controller.signal.aborted && sequence === loadSequence.current)
          setError(mailError(error));
      })
      .finally(() => {
        if (!controller.signal.aborted && sequence === loadSequence.current) setLoading(false);
      });
    return () => controller.abort();
  }, [api, ready, active, folderId, pageNumber, unreadOnly, keyword, revision]);
  useEffect(() => {
    if (!ready || !active) return;
    const controller = new AbortController();
    void api
      .folders(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setFolders(value);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [api, ready, active, revision]);
  useEffect(() => {
    if (!selectedId || !ready) {
      setReading(false);
      return;
    }
    const controller = new AbortController(),
      sequence = ++readSequence.current;
    setReading(true);
    setDetail(null);
    setError('');
    void api
      .read(selectedId, controller.signal)
      .then((value) => {
        if (controller.signal.aborted || sequence !== readSequence.current) return;
        setDetail(value);
        setPage((current) => ({
          ...current,
          items: current.items.map((item) =>
            item.id === selectedId ? { ...item, unread: false } : item,
          ),
        }));
      })
      .catch((error) => {
        if (!controller.signal.aborted && sequence === readSequence.current)
          setError(mailError(error));
      })
      .finally(() => {
        if (!controller.signal.aborted && sequence === readSequence.current) setReading(false);
      });
    return () => controller.abort();
  }, [api, selectedId, ready, searchReadRevision]);

  async function openMail(item: MailSummary): Promise<void> {
    setThreadRoot(null);
    if (
      item.draft &&
      draft &&
      composeDirty &&
      draft.draftId !== item.id &&
      !(await useDialog.getState().confirm('打开另一封草稿？', '当前未保存的写信内容将被替换。', {
        okLabel: '打开草稿',
        cancelLabel: '继续编辑',
        tone: 'warning',
      }))
    )
      return;
    setSelectedId(item.id);
    setShowCompose(false);
  }
  function start(mode: 'reply' | 'all' | 'forward' | 'edit'): void {
    if (!detail || composeBusy) return;
    if (draft && composeDirty) {
      void useDialog
        .getState()
        .confirm('替换当前写信内容？', '当前内容尚未保存到草稿箱。', {
          okLabel: '替换',
          cancelLabel: '继续编辑',
          tone: 'warning',
        })
        .then((ok) => {
          if (ok && mounted.current) {
            setDraft(draftFromMail(detail, mode, selfEmail));
            setShowCompose(true);
          }
        });
    } else {
      setDraft(draftFromMail(detail, mode, selfEmail));
      setShowCompose(true);
    }
  }
  async function act(action: MailAction, ids = selection): Promise<void> {
    if (!ids.length || actionBusy) return;
    if (
      action === 'trash' &&
      !(await useDialog
        .getState()
        .confirm('移至已删除？', `将所选 ${ids.length} 封邮件移至已删除。`, {
          okLabel: '移至已删除',
          cancelLabel: '取消',
          tone: 'warning',
        }))
    )
      return;
    setActionBusy(true);
    setError('');
    try {
      await api.action(ids, action);
      if (mounted.current) {
        if (action === 'trash') {
          setSelectedId((current) => (current && ids.includes(current) ? null : current));
          setDetail((current) => (current && ids.includes(current.id) ? null : current));
        } else
          setDetail((current) =>
            current && ids.includes(current.id)
              ? {
                  ...current,
                  ...(action === 'star' || action === 'unstar'
                    ? { starred: action === 'star' }
                    : { unread: action === 'unread' }),
                }
              : current,
          );
        setChecked((current) => current.filter((id) => !ids.includes(id)));
        setRevision((value) => value + 1);
      }
    } catch (error) {
      if (mounted.current) setError(mailError(error));
    } finally {
      if (mounted.current) setActionBusy(false);
    }
  }
  async function disconnect(): Promise<void> {
    if (composeBusy) return;
    if (
      composeDirty &&
      !(await useDialog.getState().confirm('断开邮箱连接？', '未保存的写信内容和附件将被清除。', {
        okLabel: '断开连接',
        cancelLabel: '取消',
        tone: 'warning',
      }))
    )
      return;
    try {
      await api.disconnect();
      setDraft(null);
      setShowCompose(false);
      setSelectedId(null);
      setDetail(null);
      setPage(emptyPage);
      setChecked([]);
      setStatus(initialStatus);
    } catch (error) {
      setError(mailError(error));
    }
  }
  async function saveAttachment(id: string): Promise<void> {
    if (downloading) return;
    const controller = new AbortController();
    download.current = controller;
    setDownloading(id);
    try {
      const saved = await api.download(id, controller.signal);
      if (saved && mounted.current)
        useToast.getState().push({ tone: 'success', title: '附件已保存' });
    } catch (error) {
      if (mounted.current && !controller.signal.aborted) setError(mailError(error));
    } finally {
      if (mounted.current) setDownloading(null);
      if (download.current === controller) download.current = null;
    }
  }
  const allChecked = page.items.length > 0 && page.items.every((item) => checked.includes(item.id));
  const snippets = useMemo(
    () => new Map(page.items.map((item) => [item.id, plainMailText(item.snippet)])),
    [page.items],
  );

  return (
    <section
      className="weq-mail-workspace"
      data-detail={Boolean(selectedId || showCompose)}
      aria-label="QQ 邮箱"
    >
      <header className="weq-mail-topbar">
        <div className="weq-mail-brand">
          <Mail size={22} />
          <div>
            <h1>QQ 邮箱</h1>
            <span className="weq-mail-sensitive">{selfEmail}</span>
          </div>
        </div>
        <div className="weq-mail-top-actions">
          <label className="weq-mail-notifications" title="新邮件提醒">
            <input
              type="checkbox"
              aria-label="新邮件提醒"
              checked={status.notifications}
              disabled={status.state === 'connecting' || (!ready && !status.notifications)}
              onChange={(event) => {
                void api
                  .notifications(event.target.checked)
                  .then(setStatus)
                  .catch((error) => setError(mailError(error)));
              }}
            />
            <Bell size={16} />
            <span>新邮件提醒</span>
          </label>
          <button
            type="button"
            title="刷新邮箱"
            aria-label="刷新邮箱"
            disabled={loading || status.state === 'connecting'}
            onClick={() => {
              if (ready) setRevision((value) => value + 1);
              else void connect();
            }}
          >
            {loading || status.state === 'connecting' ? (
              <LoaderCircle size={17} className="weq-mail-spin" />
            ) : (
              <RefreshCw size={17} />
            )}
          </button>
          {ready ? (
            <button
              type="button"
              title="断开邮箱连接"
              aria-label="断开邮箱连接"
              disabled={composeBusy}
              onClick={() => void disconnect()}
            >
              <Power size={17} />
            </button>
          ) : null}
          <button
            type="button"
            className="weq-mail-primary"
            disabled={!ready}
            onClick={() => {
              if (!draft) setDraft(newMailDraft());
              setShowCompose(true);
            }}
          >
            <PenLine size={16} />
            <span>{draft ? '继续写信' : '写邮件'}</span>
          </button>
        </div>
      </header>
      {error || status.error ? (
        <div className="weq-mail-error" role="alert">
          <AlertCircle size={16} />
          <span>{error || status.error}</span>
          {error ? (
            <button
              type="button"
              title="关闭提示"
              aria-label="关闭提示"
              onClick={() => setError('')}
            >
              <X size={14} />
            </button>
          ) : null}
        </div>
      ) : null}
      {!ready ? (
        <div className="weq-mail-connection">
          <Mail size={36} />
          <h2>
            {status.state === 'connecting'
              ? '正在连接邮箱'
              : status.state === 'error'
                ? '邮箱连接失败'
                : '邮箱未连接'}
          </h2>
          <button
            type="button"
            className="weq-mail-primary"
            disabled={status.state === 'connecting'}
            onClick={() => void connect()}
          >
            {status.state === 'connecting' ? (
              <LoaderCircle size={16} className="weq-mail-spin" />
            ) : (
              <Power size={16} />
            )}
            连接当前 QQ
          </button>
        </div>
      ) : (
        <div className="weq-mail-layout">
          <nav className="weq-mail-folders" aria-label="邮箱文件夹">
            {folders.map((folder) => {
              const Icon = folderIcon(folder.id);
              return (
                <button
                  key={folder.id}
                  type="button"
                  className={folder.id === folderId && !keyword ? 'is-selected' : ''}
                  aria-current={folder.id === folderId && !keyword ? 'page' : undefined}
                  onClick={() => chooseFolder(folder.id)}
                  title={folder.name}
                >
                  <Icon size={17} />
                  <span>{folder.name}</span>
                  {folder.unread > 0 ? (
                    <small>{folder.unread > 999 ? '999+' : folder.unread}</small>
                  ) : null}
                </button>
              );
            })}
            <div className="weq-mail-sync-state">
              {status.lastSync
                ? `更新于 ${new Date(status.lastSync).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit' })}`
                : '尚未同步'}
            </div>
          </nav>
          <section className="weq-mail-list" aria-label="邮件列表">
            <form
              className="weq-mail-search"
              onSubmit={(event) => {
                event.preventDefault();
                setKeyword(query.trim());
                setPageNumber(0);
                setChecked([]);
                setSelectedId(null);
                setDetail(null);
                setShowCompose(false);
              }}
            >
              <Search size={16} />
              <input
                aria-label="搜索邮件"
                placeholder="搜索邮件"
                value={query}
                maxLength={200}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query ? (
                <button
                  type="button"
                  title="清空搜索"
                  aria-label="清空搜索"
                  onClick={() => {
                    setQuery('');
                    setKeyword('');
                    setPageNumber(0);
                  }}
                >
                  <X size={14} />
                </button>
              ) : null}
              <button type="submit" title="搜索" aria-label="执行邮件搜索">
                <ChevronRight size={16} />
              </button>
            </form>
            <header className="weq-mail-list-heading">
              <h2>{keyword ? '搜索结果' : selectedFolder?.name || '邮件'}</h2>
              <span>{page.total}</span>
              <label>
                <input
                  type="checkbox"
                  checked={unreadOnly}
                  onChange={(event) => {
                    setUnreadOnly(event.target.checked);
                    setPageNumber(0);
                    setChecked([]);
                  }}
                />
                未读
              </label>
            </header>
            <div className="weq-mail-list-tools">
              <input
                type="checkbox"
                aria-label="选择当前页全部邮件"
                checked={allChecked}
                disabled={!page.items.length}
                onChange={(event) =>
                  setChecked(event.target.checked ? page.items.map((item) => item.id) : [])
                }
              />
              <span>{checked.length ? `已选 ${checked.length}` : ''}</span>
              <button
                type="button"
                title="标为已读"
                aria-label="标为已读"
                disabled={!selection.length || actionBusy}
                onClick={() => void act('read')}
              >
                <MailOpen size={16} />
              </button>
              <button
                type="button"
                title="标为未读"
                aria-label="标为未读"
                disabled={!selection.length || actionBusy}
                onClick={() => void act('unread')}
              >
                <Mail size={16} />
              </button>
              <button
                type="button"
                title="移至已删除"
                aria-label="移至已删除"
                disabled={!selection.length || actionBusy || folderId === 5}
                onClick={() => void act('trash')}
              >
                <Trash2 size={16} />
              </button>
            </div>
            <div className="weq-mail-rows" aria-busy={loading}>
              {loading && !page.items.length ? (
                <div className="weq-mail-empty">
                  <LoaderCircle size={24} className="weq-mail-spin" />
                  <span>正在加载邮件</span>
                </div>
              ) : page.items.length ? (
                page.items.map((item) => (
                  <article
                    key={item.id}
                    className={`weq-mail-row${item.id === selectedId ? ' is-selected' : ''}${item.unread ? ' is-unread' : ''}`}
                  >
                    <input
                      type="checkbox"
                      aria-label={`选择 ${item.subject || '无主题'}`}
                      checked={checked.includes(item.id)}
                      onChange={(event) =>
                        setChecked((current) =>
                          event.target.checked
                            ? [...current, item.id]
                            : current.filter((id) => id !== item.id),
                        )
                      }
                    />
                    <button
                      type="button"
                      className="weq-mail-row-main weq-mail-sensitive"
                      onClick={() => void openMail(item)}
                      aria-pressed={item.id === selectedId}
                    >
                      <div>
                        <strong>{item.sender.name || item.sender.email || '发件人'}</strong>
                        <time>{formatMailTime(item.time, true)}</time>
                      </div>
                      <span className="weq-mail-row-subject">
                        {item.draft ? <FilePenLine size={13} /> : null}
                        {item.hasAttachments ? <Paperclip size={13} /> : null}
                        <span>{item.subject || '无主题'}</span>
                      </span>
                      <p>{snippets.get(item.id) || ' '}</p>
                    </button>
                    <button
                      type="button"
                      className={`weq-mail-row-star${item.starred ? ' is-starred' : ''}`}
                      title={item.starred ? '取消星标' : '设为星标'}
                      aria-label={`${item.starred ? '取消星标' : '设为星标'} ${item.subject || '无主题'}`}
                      aria-pressed={item.starred}
                      disabled={actionBusy}
                      onClick={() => void act(item.starred ? 'unstar' : 'star', [item.id])}
                    >
                      <Star size={14} fill={item.starred ? 'currentColor' : 'none'} />
                    </button>
                  </article>
                ))
              ) : (
                <div className="weq-mail-empty">
                  <Inbox size={30} />
                  <span>{keyword ? '没有找到邮件' : unreadOnly ? '没有未读邮件' : '没有邮件'}</span>
                </div>
              )}
            </div>
            <footer className="weq-mail-pagination">
              <button
                type="button"
                title="上一页"
                aria-label="上一页"
                disabled={pageNumber === 0 || loading}
                onClick={() => {
                  setPageNumber((value) => value - 1);
                  setChecked([]);
                }}
              >
                <ChevronLeft size={17} />
              </button>
              <span>
                {pageNumber + 1} / {Math.max(1, Math.ceil(page.total / 30))}
              </span>
              <button
                type="button"
                title="下一页"
                aria-label="下一页"
                disabled={!page.hasMore || loading}
                onClick={() => {
                  setPageNumber((value) => value + 1);
                  setChecked([]);
                }}
              >
                <ChevronRight size={17} />
              </button>
            </footer>
          </section>
          <div className="weq-mail-reader-shell">
            {draft ? (
              <MailComposer
                key={draft.key}
                initial={draft}
                api={api}
                ready={ready}
                hidden={!showCompose}
                onBusyChange={setComposeBusy}
                onDirtyChange={setComposeDirty}
                onClose={() => {
                  setDraft(null);
                  setShowCompose(false);
                }}
                onInspect={(id) => chooseFolder(id)}
                onSubmitted={(id) => {
                  setDraft(null);
                  setRevision((value) => value + 1);
                  if (composeVisible.current) {
                    chooseFolder(3);
                    setSelectedId(id || null);
                  }
                  setShowCompose(false);
                }}
              />
            ) : null}
            <section className="weq-mail-reader" hidden={showCompose} aria-label="邮件阅读区">
              <div className="weq-mail-reader-tools">
                <button
                  type="button"
                  className="weq-mail-mobile-back"
                  title="返回邮件列表"
                  aria-label="返回邮件列表"
                  onClick={() => {
                    setSelectedId(null);
                    setDetail(null);
                  }}
                >
                  <ArrowLeft size={17} />
                </button>
                {detail ? (
                  <>
                    {threadRoot && selectedId !== threadRoot ? (
                      <button type="button" onClick={() => setSelectedId(threadRoot)}>
                        <ArrowLeft size={16} />
                        会话
                      </button>
                    ) : null}
                    {detail.thread ? null : detail.draft ? (
                      <button type="button" onClick={() => start('edit')} disabled={composeBusy}>
                        <FilePenLine size={16} />
                        编辑草稿
                      </button>
                    ) : (
                      <>
                        <button type="button" onClick={() => start('reply')} disabled={composeBusy}>
                          <Reply size={16} />
                          回复
                        </button>
                        <button
                          type="button"
                          title="回复全部"
                          aria-label="回复全部"
                          onClick={() => start('all')}
                          disabled={composeBusy}
                        >
                          <ReplyAll size={17} />
                        </button>
                        <button
                          type="button"
                          onClick={() => start('forward')}
                          disabled={composeBusy}
                        >
                          <Forward size={16} />
                          转发
                        </button>
                      </>
                    )}
                    <span />
                    <button
                      type="button"
                      title={detail.starred ? '取消星标' : '设为星标'}
                      aria-label={detail.starred ? '取消星标' : '设为星标'}
                      disabled={actionBusy}
                      onClick={() => void act(detail.starred ? 'unstar' : 'star', [detail.id])}
                    >
                      <Star size={17} fill={detail.starred ? 'currentColor' : 'none'} />
                    </button>
                    <button
                      type="button"
                      title="移至已删除"
                      aria-label="删除当前邮件"
                      disabled={actionBusy || detail.folderId === 5}
                      onClick={() => void act('trash', [detail.id])}
                    >
                      <Trash2 size={17} />
                    </button>
                  </>
                ) : null}
              </div>
              {reading ? (
                <div className="weq-mail-empty">
                  <LoaderCircle size={24} className="weq-mail-spin" />
                  <span>正在读取邮件</span>
                </div>
              ) : detail ? (
                <>
                  <header className="weq-mail-message-heading weq-mail-sensitive">
                    <h2>{detail.subject || '无主题'}</h2>
                    <div>
                      <strong>{detail.sender.name || detail.sender.email}</strong>
                      <span>{detail.sender.name ? detail.sender.email : ''}</span>
                    </div>
                    <details>
                      <summary>收件人：{addressText(detail.to) || selfEmail}</summary>
                      <p>收件人：{addressText(detail.to) || selfEmail}</p>
                      {detail.cc.length ? <p>抄送：{addressText(detail.cc)}</p> : null}
                      {detail.bcc.length ? <p>密送：{addressText(detail.bcc)}</p> : null}
                    </details>
                    <time>{formatMailTime(detail.time)}</time>
                  </header>
                  {detail.thread ? (
                    <div className="weq-mail-thread weq-mail-sensitive">
                      <h3>{detail.thread.length} 封邮件</h3>
                      {detail.thread.map((item) => (
                        <button
                          type="button"
                          key={item.id}
                          onClick={() => {
                            setThreadRoot(detail.id);
                            setSelectedId(item.id);
                          }}
                        >
                          <strong>{item.sender.name || item.sender.email || '发件人'}</strong>
                          <span>{item.subject || '无主题'}</span>
                          <time>{formatMailTime(item.time)}</time>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="weq-mail-message-content weq-mail-sensitive">
                      <MailBody key={detail.id} html={detail.html} api={api} />
                    </div>
                  )}
                  {detail.attachments.length ? (
                    <div className="weq-mail-attachments">
                      <h3>
                        附件 <span>{detail.attachments.length}</span>
                      </h3>
                      {detail.attachments.map((item) => (
                        <div className="weq-mail-file" key={item.id}>
                          <Paperclip size={16} />
                          <span className="weq-mail-sensitive" title={item.name}>
                            {item.name}
                          </span>
                          <small>
                            {formatMailSize(item.size)}
                            {item.big ? ' · 超大附件' : ''}
                          </small>
                          <button
                            type="button"
                            title="保存附件"
                            aria-label={`保存附件 ${item.name}`}
                            disabled={!item.available || Boolean(downloading)}
                            onClick={() => void saveAttachment(item.id)}
                          >
                            {downloading === item.id ? (
                              <LoaderCircle size={16} className="weq-mail-spin" />
                            ) : (
                              <Download size={16} />
                            )}
                          </button>
                          {downloading === item.id ? (
                            <button
                              type="button"
                              title="取消下载"
                              aria-label="取消附件下载"
                              onClick={() => download.current?.abort()}
                            >
                              <X size={14} />
                            </button>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="weq-mail-empty">
                  <MailOpen size={36} />
                  <span>未选择邮件</span>
                </div>
              )}
            </section>
          </div>
        </div>
      )}
    </section>
  );
}
