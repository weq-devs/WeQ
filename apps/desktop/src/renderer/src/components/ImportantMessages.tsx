import { useEffect, useRef, useState } from 'react';
import { ListFilter, LocateFixed, RefreshCw, X } from 'lucide-react';
import { eventTimeFormatter } from '@weq/time';
import { client, trpc } from '../trpc/client';
import { useViewState } from '../state/view';
import { OverlayLayer } from './OverlayLayer';
import { highlightLabel } from '../im-template/template/unreadDock';
import type { ConversationHighlightKind } from '../im-template/template/types';
import type { ReplyJumpTarget } from '../state/messageContext';
import '../styles/important-messages.css';

type Page = Awaited<ReturnType<typeof client.account.listImportantGroupMessages.query>>;
const kinds: ConversationHighlightKind[] = [
  'atMe',
  'atAll',
  'replyMe',
  'specialCare',
  'groupKeyword',
  'newFile',
  'groupAnnouncement',
  'redPacket',
  'unknown',
];

export function ImportantMessagesButton({
  groupCode,
  senderName,
  onLocate,
}: {
  groupCode: string;
  senderName: (uid: string) => string;
  onLocate: (target: ReplyJumpTarget) => void | Promise<void>;
}) {
  const uin = useViewState((state) => state.openedUin);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const config = trpc.account.getAccountConfig.useQuery(undefined, {
    enabled: open && Boolean(uin),
    staleTime: 0,
  });
  const source = config.data?.uin === uin ? config.data : undefined;
  const previousConfig = useRef<string | undefined>(undefined);
  useEffect(() => setOpen(false), [groupCode, uin]);
  useEffect(() => {
    if (previousConfig.current && source?.configId && previousConfig.current !== source.configId)
      setOpen(false);
    previousConfig.current = source?.configId;
  }, [source?.configId]);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="icon-button group-header-info-action"
        title="重要消息"
        aria-label="重要消息"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
      >
        <ListFilter size={18} />
      </button>
      {open ? (
        <OverlayLayer
          key={source?.configId ?? 'loading'}
          presentation="popover"
          anchor={anchor.current}
          anchorPlacement="below"
          title="重要消息"
          className="weq-important-layer"
          consumeOutsidePress={false}
          onClose={() => setOpen(false)}
        >
          {source?.configId && uin ? (
            <ImportantMessagesList
              key={`${uin}:${source.configId}:${groupCode}`}
              groupCode={groupCode}
              binding={{ expectedAccountUin: uin, expectedAccountConfigId: source.configId }}
              senderName={senderName}
              onLocate={onLocate}
              onClose={() => setOpen(false)}
            />
          ) : (
            <section className="weq-important-messages">
              <header>
                <strong>重要消息</strong>
                <button
                  type="button"
                  className="icon-button"
                  title="关闭重要消息"
                  aria-label="关闭重要消息"
                  onClick={() => setOpen(false)}
                >
                  <X size={16} />
                </button>
              </header>
              <p role={config.error ? 'alert' : 'status'}>
                {config.error ? '账号读取失败' : '正在读取账号…'}
              </p>
              {config.error ? (
                <button type="button" onClick={() => void config.refetch()}>
                  重试
                </button>
              ) : null}
            </section>
          )}
        </OverlayLayer>
      ) : null}
    </>
  );
}

export function ImportantMessagesList({
  groupCode,
  binding,
  senderName,
  onLocate,
  onClose,
}: {
  groupCode: string;
  binding: { expectedAccountUin: string; expectedAccountConfigId: string };
  senderName: (uid: string) => string;
  onLocate: (target: ReplyJumpTarget) => void | Promise<void>;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<ConversationHighlightKind | ''>('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [page, setPage] = useState<Page>({
    items: [],
    nextBefore: null,
    contentUnavailable: false,
  });
  const [request, setRequest] = useState<{ id: number; before?: string }>({ id: 0 });
  const [pending, setPending] = useState(true);
  const [error, setError] = useState('');
  const [locating, setLocating] = useState<string | null>(null);
  const [locateError, setLocateError] = useState('');
  const alive = useRef(true);
  const source = `${binding.expectedAccountUin}:${binding.expectedAccountConfigId}:${groupCode}`;
  const scope = useRef(source);
  scope.current = source;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const { expectedAccountUin, expectedAccountConfigId } = binding;
  useEffect(() => {
    let active = true;
    setPending(true);
    setError('');
    if (!request.before) setPage({ items: [], nextBefore: null, contentUnavailable: false });
    void client.account.listImportantGroupMessages
      .query({
        expectedAccountUin,
        expectedAccountConfigId,
        groupCode,
        kind: kind || undefined,
        unreadOnly,
        before: request.before,
      })
      .then((result) => {
        if (!active) return;
        setPage((old) => ({
          ...result,
          items: request.before ? [...old.items, ...result.items] : result.items,
        }));
        setPending(false);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : '重要消息读取失败');
        setPending(false);
      });
    return () => {
      active = false;
    };
  }, [expectedAccountUin, expectedAccountConfigId, groupCode, kind, unreadOnly, request]);

  async function locate(row: Page['items'][number]) {
    if (locating) return;
    const started = scope.current;
    setLocating(row.msgSeq);
    setLocateError('');
    try {
      await onLocate({ seq: row.msgSeq, msgId: row.msgId });
    } catch (reason) {
      if (alive.current && scope.current === started)
        setLocateError(reason instanceof Error ? reason.message : '定位失败，请重试');
    } finally {
      if (alive.current && scope.current === started) setLocating(null);
    }
  }
  return (
    <section
      className="weq-important-messages"
      role="dialog"
      aria-label="重要消息"
      aria-busy={pending}
    >
      <header>
        <strong>重要消息</strong>
        <div>
          <button
            type="button"
            className="icon-button"
            title="刷新重要消息"
            aria-label="刷新重要消息"
            disabled={pending}
            onClick={() => setRequest((old) => ({ id: old.id + 1 }))}
          >
            <RefreshCw size={16} />
          </button>
          <button
            type="button"
            className="icon-button"
            title="关闭重要消息"
            aria-label="关闭重要消息"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
      </header>
      <div className="weq-important-filters">
        <select
          aria-label="重要消息类型"
          value={kind}
          onChange={(event) => {
            setKind(event.target.value as ConversationHighlightKind | '');
            setRequest((old) => ({ id: old.id + 1 }));
          }}
        >
          <option value="">全部类型</option>
          {kinds.map((value) => (
            <option key={value} value={value}>
              {highlightLabel(value)}
            </option>
          ))}
        </select>
        <label>
          <input
            type="checkbox"
            checked={unreadOnly}
            onChange={(event) => {
              setUnreadOnly(event.target.checked);
              setRequest((old) => ({ id: old.id + 1 }));
            }}
          />
          仅未读
        </label>
      </div>
      {error ? (
        <p role="alert">
          {error}
          <button type="button" onClick={() => setRequest((old) => ({ ...old, id: old.id + 1 }))}>
            重试
          </button>
        </p>
      ) : null}
      {locateError ? <p role="alert">{locateError}</p> : null}
      {page.contentUnavailable ? <p role="status">原消息摘要暂时不可用</p> : null}
      <ul aria-label="重要消息列表">
        {page.items.map((row) => {
          const date = new Date(Number(row.sendTime) * 1000);
          const time =
            Number(row.sendTime) > 0 && !Number.isNaN(date.getTime())
              ? eventTimeFormatter.format(date)
              : '时间未知';
          return (
            <li key={row.msgSeq}>
              <button
                type="button"
                className="weq-important-row"
                title="定位原消息"
                disabled={locating !== null}
                onClick={() => void locate(row)}
              >
                <span className="weq-important-meta">
                  <strong data-privacy-sensitive>
                    {senderName(row.senderUid) || row.senderUid || '未知发送者'}
                  </strong>
                  <time>{time}</time>
                </span>
                <span className="weq-important-reasons" data-privacy-sensitive>
                  {row.reasons
                    .map(
                      (reason) =>
                        `${highlightLabel(reason.kind)}${reason.kind === 'groupKeyword' && reason.text ? `「${reason.text}」` : ''}`,
                    )
                    .join(' · ')}
                  {row.unread ? ' · 未读' : ''}
                </span>
                <span className="weq-important-preview" data-privacy-sensitive>
                  {row.preview ||
                    row.reasons.find((reason) => reason.text)?.text ||
                    `消息 ${row.msgSeq}`}
                </span>
                <LocateFixed size={16} className="weq-important-locate" aria-hidden />
                {locating === row.msgSeq ? <span role="status">正在定位…</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
      {pending ? (
        <p role="status">正在读取重要消息…</p>
      ) : !error && !page.items.length ? (
        <p role="status">{unreadOnly ? '暂无未读重要消息' : '暂无已记录的重要消息'}</p>
      ) : null}
      {page.nextBefore ? (
        <button
          type="button"
          className="weq-important-more"
          disabled={pending}
          onClick={() => setRequest((old) => ({ id: old.id + 1, before: page.nextBefore! }))}
        >
          加载更多
        </button>
      ) : null}
    </section>
  );
}
