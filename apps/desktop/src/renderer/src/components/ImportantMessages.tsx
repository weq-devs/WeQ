import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  AtSign,
  Bell,
  File,
  Gift,
  Layers,
  ListFilter,
  Loader2,
  Megaphone,
  Reply,
  Users,
  X,
  RefreshCw,
} from 'lucide-react';
import { eventTimeFormatter } from '@weq/time';
import { FEATURE_ICONS } from '../lib/featureIcons.shared';
import { client, trpc } from '../trpc/client';
import { useViewState } from '../state/view';
import { OverlayLayer } from './OverlayLayer';
import {
  highlightLabel,
  IMPORTANT_MESSAGE_KINDS,
  type ImportantMessageKind,
} from '../im-template/template/unreadDock';
import type { ReplyJumpTarget } from '../state/messageContext';
import { useMultiSelection } from '../hooks/useMultiSelection';
import { useMessageLocateMenu } from '../hooks/useMessageLocateMenu';
import { useMobileWebLayout } from '../hooks/useMobileWebViewport';
import { useSurfaceEscapeDismissal } from '../lib/surfaceEscape';
import '../styles/search-scope.css';
import '../styles/important-messages.css';

type Page = Awaited<ReturnType<typeof client.account.listImportantGroupMessages.query>>;
const icons = {
  atMe: AtSign,
  atAll: Users,
  replyMe: Reply,
  specialCare: FEATURE_ICONS.specialCare,
  groupKeyword: Bell,
  newFile: File,
  groupAnnouncement: Megaphone,
  redPacket: Gift,
};
type PanelProps = {
  groupCode: string;
  open: boolean;
  onClose: () => void;
  senderName: (uid: string) => string;
  onLocate: (target: ReplyJumpTarget) => void | Promise<void>;
  activeSeq?: string | null;
  locatePending?: boolean;
  navigationAnchor?: HTMLElement | null;
};

export function ImportantMessagesButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className="icon-button group-header-info-action"
      title="重要消息"
      aria-label="重要消息"
      aria-expanded={open}
      aria-controls="weq-important-messages"
      onClick={onClick}
    >
      <ListFilter size={18} />
    </button>
  );
}

export function ImportantMessagesPanel({ groupCode, open, onClose, ...props }: PanelProps) {
  const uin = useViewState((state) => state.openedUin);
  const config = trpc.account.getAccountConfig.useQuery(undefined, {
    enabled: open && Boolean(uin),
    staleTime: 0,
  });
  const source = config.data?.uin === uin ? config.data : undefined;
  return source?.configId && uin ? (
    <ImportantMessagesList
      key={`${uin}:${source.configId}:${groupCode}`}
      {...props}
      groupCode={groupCode}
      open={open}
      onClose={onClose}
      binding={{ expectedAccountUin: uin, expectedAccountConfigId: source.configId }}
    />
  ) : (
    <ImportantMessageSurface
      open={open}
      onClose={onClose}
      navigationAnchor={props.navigationAnchor}
    >
      <p role={config.error ? 'alert' : 'status'}>
        {config.error ? '账号读取失败' : '正在读取账号…'}
      </p>
      {config.error ? (
        <button type="button" onClick={() => void config.refetch()} className="weq-retry-button">
          <RefreshCw size={14} aria-hidden />
          重试
        </button>
      ) : null}
    </ImportantMessageSurface>
  );
}

function ImportantMessageSurface({
  open,
  onClose,
  children,
  navigationAnchor,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  navigationAnchor?: HTMLElement | null;
}) {
  const mobile = useMobileWebLayout();
  const ref = useRef<HTMLElement>(null);
  useSurfaceEscapeDismissal(ref, onClose, open && !mobile);
  useEffect(() => {
    if (open && !mobile) ref.current?.focus({ preventScroll: true });
  }, [open, mobile]);
  const content = (
    <aside
      ref={ref}
      tabIndex={-1}
      data-weq-escape-surface={open && !mobile ? '' : undefined}
      id="weq-important-messages"
      className="weq-important-messages"
      aria-label="重要消息"
      hidden={!mobile && !open}
    >
      <header>
        <strong>重要消息</strong>
        <button
          type="button"
          className="icon-button"
          title="关闭重要消息"
          aria-label="关闭重要消息"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      {children}
    </aside>
  );
  return mobile ? (
    <OverlayLayer
      open={open}
      presentation="panel"
      title="重要消息"
      className="weq-important-drawer"
      onClose={onClose}
      anchor={navigationAnchor}
    >
      {content}
    </OverlayLayer>
  ) : (
    content
  );
}

export function ImportantMessagesList({
  groupCode,
  binding,
  senderName,
  onLocate,
  onClose,
  open = true,
  activeSeq,
  locatePending = false,
  navigationAnchor,
}: Omit<PanelProps, 'open'> & {
  open?: boolean;
  binding: { expectedAccountUin: string; expectedAccountConfigId: string };
}) {
  const mobile = useMobileWebLayout();
  const [kinds, setKinds] = useState<Set<ImportantMessageKind>>(
    () => new Set(IMPORTANT_MESSAGE_KINDS),
  );
  const [page, setPage] = useState<Page>({
    items: [],
    nextBefore: null,
    contentUnavailable: false,
  });
  const [request, setRequest] = useState<{ id: number; before?: string }>({ id: 0 });
  const [pending, setPending] = useState(true);
  const [error, setError] = useState('');
  const [locating, setLocating] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [locateError, setLocateError] = useState('');
  const list = useRef<HTMLUListElement>(null);
  const scrollTop = useRef(0);
  const initialized = useRef(false);
  const prepend = useRef<{ seq: string; top: number } | null>(null);
  const busy = useRef(false);
  const alive = useRef(true);
  const lastRequest = useRef('');
  const source = `${binding.expectedAccountUin}:${binding.expectedAccountConfigId}:${groupCode}`;
  const scope = useRef(source);
  scope.current = source;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const changeKinds = (next: Set<ImportantMessageKind>) => {
    setKinds(next);
    setRequest((old) => ({ id: old.id + 1 }));
    scrollTop.current = 0;
    initialized.current = false;
    prepend.current = null;
    focusedSeq.current = null;
  };
  const selection = useMultiSelection({
    ids: IMPORTANT_MESSAGE_KINDS,
    selected: kinds,
    onChange: changeKinds,
  });
  const { expectedAccountUin, expectedAccountConfigId } = binding;
  useEffect(() => {
    if (!open) return;
    let active = true;
    const key = JSON.stringify([source, [...kinds], request]);
    const refresh = lastRequest.current === key;
    lastRequest.current = key;
    setError('');
    if (!refresh && !request.before)
      setPage({ items: [], nextBefore: null, contentUnavailable: false });
    if (!kinds.size) {
      setPending(false);
      return;
    }
    setPending(true);
    void client.account.listImportantGroupMessages
      .query({
        expectedAccountUin,
        expectedAccountConfigId,
        groupCode,
        kinds: [...kinds],
        before: refresh ? undefined : request.before,
      })
      .then((result) => {
        if (!active) return;
        setPage((old) => {
          if (
            refresh &&
            result.items.some((row) => old.items.some((prior) => prior.msgSeq === row.msgSeq))
          ) {
            const rows = new Map([...old.items, ...result.items].map((row) => [row.msgSeq, row]));
            return {
              ...result,
              nextBefore: old.nextBefore,
              items: [...rows.values()].sort((a, b) =>
                BigInt(a.msgSeq) > BigInt(b.msgSeq) ? -1 : 1,
              ),
            };
          }
          return {
            ...result,
            items: !refresh && request.before ? [...old.items, ...result.items] : result.items,
          };
        });
        setPending(false);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        prepend.current = null;
        setError(reason instanceof Error ? reason.message : '重要消息读取失败');
        setPending(false);
      });
    return () => {
      active = false;
    };
  }, [open, source, expectedAccountUin, expectedAccountConfigId, groupCode, kinds, request]);
  const currentSeq = activeSeq ?? selected;
  const focusedSeq = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (open && list.current) list.current.scrollTop = scrollTop.current;
  }, [open, mobile]);
  useLayoutEffect(() => {
    const element = list.current;
    if (!open || !element || !page.items.length) return;
    if (prepend.current) {
      const anchor = element.querySelector<HTMLElement>(
        `[data-important-seq="${prepend.current.seq}"]`,
      );
      if (anchor) element.scrollTop += anchor.getBoundingClientRect().top - prepend.current.top;
      prepend.current = null;
    } else if (!initialized.current) {
      element.scrollTop = element.scrollHeight;
    }
    initialized.current = true;
    scrollTop.current = element.scrollTop;
  }, [open, page.items]);
  useLayoutEffect(() => {
    if (!open || !currentSeq || focusedSeq.current === currentSeq) return;
    const item = [
      ...(list.current?.querySelectorAll<HTMLElement>('[data-important-seq]') ?? []),
    ].find((item) => item.dataset.importantSeq === currentSeq);
    if (!item) return;
    item.scrollIntoView?.({ block: 'nearest' });
    scrollTop.current = list.current?.scrollTop ?? 0;
    focusedSeq.current = currentSeq;
  }, [open, currentSeq, page.items]);
  async function locate(target: ReplyJumpTarget) {
    if (busy.current || locatePending) return;
    const started = scope.current;
    busy.current = true;
    setLocating(String(target.seq));
    setLocateError('');
    try {
      await onLocate(target);
      if (!alive.current || scope.current !== started) return;
      setSelected(String(target.seq));
      if (mobile) onClose();
    } catch (reason) {
      if (alive.current && scope.current === started)
        setLocateError(reason instanceof Error ? reason.message : '定位失败，请重试');
    } finally {
      busy.current = false;
      if (alive.current && scope.current === started) setLocating(null);
    }
  }
  const locateMenu = useMessageLocateMenu(locate, `${source}:${open}`);
  return (
    <ImportantMessageSurface open={open} onClose={onClose} navigationAnchor={navigationAnchor}>
      <div
        className="weq-search-scope weq-important-filters"
        role="group"
        aria-label="重要消息类型"
        {...selection.rootProps}
      >
        <button
          type="button"
          aria-label="全部类型"
          aria-pressed={
            kinds.size === IMPORTANT_MESSAGE_KINDS.length ? true : kinds.size ? 'mixed' : false
          }
          onClick={() =>
            changeKinds(
              new Set(kinds.size === IMPORTANT_MESSAGE_KINDS.length ? [] : IMPORTANT_MESSAGE_KINDS),
            )
          }
        >
          <Layers size={14} />
          {kinds.size === IMPORTANT_MESSAGE_KINDS.length ? '清空' : '全部'}
        </button>
        {IMPORTANT_MESSAGE_KINDS.map((kind) => {
          const Icon = icons[kind];
          return (
            <button
              key={kind}
              data-important-kind={kind}
              type="button"
              aria-pressed={kinds.has(kind)}
              {...selection.itemProps(kind)}
            >
              <Icon size={14} />
              {highlightLabel(kind)}
            </button>
          );
        })}
      </div>
      {error ? (
        <p role="alert">
          {error}
          <button
            type="button"
            onClick={() => setRequest((old) => ({ ...old, id: old.id + 1 }))}
            className="weq-retry-button"
          >
            <RefreshCw size={14} aria-hidden />
            重试
          </button>
        </p>
      ) : null}
      {locateError || locateMenu.error ? (
        <p role="alert">{locateError || locateMenu.error}</p>
      ) : null}
      {page.contentUnavailable ? <p role="status">原消息摘要暂时不可用</p> : null}
      {page.nextBefore ? (
        <button
          type="button"
          className="weq-important-more"
          disabled={pending}
          onClick={() => {
            if (list.current) {
              const top = list.current.getBoundingClientRect().top;
              const anchor = [
                ...list.current.querySelectorAll<HTMLElement>('[data-important-seq]'),
              ].find((item) => item.getBoundingClientRect().bottom > top);
              if (anchor)
                prepend.current = {
                  seq: anchor.dataset.importantSeq!,
                  top: anchor.getBoundingClientRect().top,
                };
            }
            setRequest((old) => ({ id: old.id + 1, before: page.nextBefore! }));
          }}
        >
          加载更早消息
        </button>
      ) : null}
      <ul
        ref={list}
        aria-label="重要消息列表"
        aria-busy={pending}
        onScroll={(event) => {
          scrollTop.current = event.currentTarget.scrollTop;
        }}
      >
        {page.items
          .slice()
          .reverse()
          .map((row) => {
            const date = new Date(Number(row.sendTime) * 1000);
            const time =
              Number(row.sendTime) > 0 && !Number.isNaN(date.getTime())
                ? eventTimeFormatter.format(date)
                : '时间未知';
            const sender = senderName(row.senderUid) || row.senderUid || '未知发送者';
            const preview =
              row.preview ||
              row.reasons.find((reason) => reason.text)?.text ||
              `消息 ${row.msgSeq}`;
            const kinds = IMPORTANT_MESSAGE_KINDS.filter((kind) =>
              row.reasons.some((reason) => reason.kind === kind),
            );
            const reasonLabel = (kind: ImportantMessageKind) =>
              row.reasons
                .filter((reason) => reason.kind === kind)
                .map(
                  (reason) =>
                    `${highlightLabel(kind)}${kind === 'groupKeyword' && reason.text ? `「${reason.text}」` : ''}`,
                )
                .join('、');
            return (
              <li key={row.msgSeq}>
                <button
                  type="button"
                  className="weq-important-row"
                  data-important-seq={row.msgSeq}
                  aria-current={row.msgSeq === currentSeq ? 'true' : undefined}
                  disabled={locating !== null || locatePending}
                  aria-busy={locating === row.msgSeq}
                  aria-label={`${kinds.map(reasonLabel).join('、')}，${sender}，${time}，${preview}`}
                  title={`${time} · 定位到原消息`}
                  onClick={() => void locate({ seq: row.msgSeq, msgId: row.msgId })}
                  onContextMenu={(event) =>
                    locateMenu.openMenu(event, { seq: row.msgSeq, msgId: row.msgId })
                  }
                >
                  <span className="weq-important-types">
                    {kinds.map((kind) => {
                      const Icon = icons[kind];
                      return (
                        <span key={kind} data-important-kind={kind} title={reasonLabel(kind)}>
                          <Icon size={14} aria-hidden />
                        </span>
                      );
                    })}
                  </span>
                  <strong className="weq-important-sender" data-privacy-sensitive>
                    {sender}
                  </strong>
                  <span className="weq-important-preview" data-privacy-sensitive>
                    {preview}
                  </span>
                  {locating === row.msgSeq ? (
                    <Loader2
                      className="weq-important-locating"
                      size={14}
                      role="status"
                      aria-label="正在定位"
                    />
                  ) : null}
                </button>
              </li>
            );
          })}
      </ul>
      {pending ? (
        <p role="status">正在读取重要消息…</p>
      ) : !error && !page.items.length ? (
        <p role="status">{kinds.size ? '暂无已记录的重要消息' : '未选择消息类型'}</p>
      ) : null}
      {locateMenu.menu}
    </ImportantMessageSurface>
  );
}
