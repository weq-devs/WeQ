import * as timeFormat from '@weq/time';
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { X } from 'lucide-react';
import { client } from '../trpc/client';
import { LoadingIndicator } from './LoadingIndicator';
import {
  QqMessageContent,
  ConvContext,
  ForwardCarrierContext,
  ForwardKindContext,
  ForwardSubRecordsContext,
  MsgDecorationEnabledContext,
} from './QqMessageContent';
import { GrayTipLine, grayTipOf } from '../im-template/template/messageRow';
import { useMsgDecoration } from '../hooks/useMsgDecoration';
import { useActiveWidget } from '../hooks/useActiveWidget';
import { useBubbleFontFx } from '../hooks/useBubbleFontFx';
import { useSurfaceEscape } from '../lib/surfaceEscape';
import type { ResolvedWidget } from '@weq/service';
import { ProfileAvatar } from './ProfileAvatar';
import { visibleViewport } from '../lib/visibleViewport';
import { ChatMediaGallery } from './ChatMediaGallery';

import {
  useForwardStore,
  ForwardParentContext,
  WINDOW_WIDTH,
  WINDOW_HEIGHT,
  forwardWindowStyle,
  type ForwardWindowState,
  type ForwardRecordWire,
} from '../state/forwardWindow';

// ---- helpers -------------------------------------------------------------

function senderAvatarFromUin(uin: string | undefined): string | null {
  if (!uin || uin === '0') return null;
  return `https://thirdqq.qlogo.cn/g?b=sdk&s=0&nk=${uin}`;
}

function formatForwardTime(seconds: string | undefined): string {
  return Number(seconds) > 0 ? timeFormat.formatUnixTime(seconds) : '';
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/**
 * 转发窗口里给灰条组件用的最小会话上下文。
 *
 * 灰条（撤回 / 戳一戳 / 群提示 / XML 提示）优先按 `conversation.members` 把 uid 解析
 * 成昵称；转发窗口没有成员表，于是它们退回灰条自带的 nick 字段 —— 这正是主面板在
 * 「成员不在已加载分页里」时的同一条退路。这里给一个空成员的会话对象即可让类型与
 * 分支都成立，不会凭空造出假名字。
 */
function forwardGrayTipConversation(kind: 'c2c' | 'group'): never {
  const base = {
    id: '',
    updatedAt: '',
    lastMessage: null,
    members: [] as unknown[],
    preference: { pinned: false, muted: false, blocked: false },
    unreadCount: 0,
  };
  if (kind === 'group') {
    return {
      ...base,
      type: 'group',
      group: {
        id: '',
        name: '',
        identityLabel: 'Group',
        identityValue: '',
        avatarUrl: null,
        announcement: null,
        memberCount: 0,
        role: 'member',
      },
      otherUser: null,
    } as never;
  }
  return {
    ...base,
    type: 'direct',
    otherUser: {
      id: '',
      identityLabel: 'UID',
      identityValue: '',
      username: '',
      displayName: '',
      avatarUrl: null,
    },
    group: null,
  } as never;
}

// ---- single window -------------------------------------------------------

function ForwardWindowFrame({ win }: { win: ForwardWindowState }): ReactElement {
  const close = useForwardStore((s) => s.close);
  const bringToFront = useForwardStore((s) => s.bringToFront);
  const move = useForwardStore((s) => s.move);
  const setRecords = useForwardStore((s) => s.setRecords);
  const setError = useForwardStore((s) => s.setError);
  const surface = useRef<HTMLElement>(null);
  const [viewport, setViewport] = useState(() => visibleViewport());
  useEffect(() => {
    const update = () => setViewport(visibleViewport());
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    return () => {
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
    };
  }, []);
  useSurfaceEscape(surface, () => close(win.id), true, false);

  // Initial fetch — only when no payload was injected up-front.
  useEffect(() => {
    if (win.records !== null) return;
    let cancelled = false;
    client.account.getForwardMessages
      .query({ kind: win.kind, msgId: win.msgId, ...(win.resId ? { resId: win.resId } : {}) })
      .then((records) => {
        if (cancelled) return;
        setRecords(win.id, records as ForwardRecordWire[]);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[forward] getForwardMessages failed', err);
        setError(win.id, (err as Error)?.message || 'Failed to load forward');
      });
    return () => {
      cancelled = true;
    };
    // We intentionally depend only on the identity — the rest of the state is
    // mutated by the very setters we call from here.
  }, [win.id, win.kind, win.msgId, win.resId, win.records, setRecords, setError]);

  // Drag — only the header is a handle. Capture the pointer on the header so a
  // fast drag past the window edge keeps tracking instead of stalling on the
  // viewport background. The window is clamped to the viewport on every move.
  const dragStateRef = useRef<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);

  const onHeaderPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      // Ignore drags that start on the close button or any nested control.
      const target = event.target as HTMLElement;
      if (target.closest('button')) return;

      bringToFront(win.id);
      dragStateRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        originX: win.x,
        originY: win.y,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [bringToFront, win.id, win.x, win.y],
  );

  const onHeaderPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      const drag = dragStateRef.current;
      if (!drag) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      const bounds = visibleViewport();
      const width = Math.min(WINDOW_WIDTH, bounds.width - 16);
      const height = Math.min(WINDOW_HEIGHT, bounds.height - 16);
      move(
        win.id,
        clamp(drag.originX + dx, bounds.left + 8, bounds.left + bounds.width - width - 8),
        clamp(drag.originY + dy, bounds.top + 8, bounds.top + bounds.height - height - 8),
      );
    },
    [move, win.id],
  );

  const onHeaderPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    dragStateRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* already released */
    }
  }, []);

  // 占位和正文共用 left/top 布局，正文就绪后不重新播放入场动画或改变位置。
  const style: CSSProperties = useMemo(() => forwardWindowStyle(win, viewport), [win, viewport]);

  // 转发窗口挂在 App 根部、MainView 之外，拿不到聊天区那两个 provider——
  // 这里补上，否则窗口里的视频/文件下载既不知道群号也不知道自己是转发内容。
  const carrier = useMemo(
    (): { msgId: string; kind: 'c2c' | 'group' } => ({ msgId: win.rootMsgId, kind: win.kind }),
    [win.rootMsgId, win.kind],
  );
  const galleryMessages = useMemo(
    () =>
      (win.records ?? []).map((record) => ({
        ...record,
        sendTime: record.sendTime ?? '0',
      })),
    [win.records],
  );

  return (
    <section
      ref={surface}
      tabIndex={-1}
      className="weq-forward-window"
      style={style}
      role="dialog"
      aria-label={win.title}
      onMouseDown={() => bringToFront(win.id)}
    >
      <header
        className="weq-forward-header"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        onPointerCancel={onHeaderPointerUp}
      >
        <div className="weq-forward-title" title={win.title}>
          {win.title}
        </div>
        <button
          type="button"
          className="weq-forward-close"
          aria-label="关闭"
          title="关闭"
          onClick={() => close(win.id)}
        >
          <X size={16} strokeWidth={1.9} />
        </button>
      </header>
      <ForwardParentContext.Provider value={win.id}>
        <ForwardKindContext.Provider value={win.kind}>
          <ConvContext.Provider value={win.conv}>
            <ForwardCarrierContext.Provider value={carrier}>
              <ForwardSubRecordsProvider records={win.records ?? []}>
                <ChatMediaGallery
                  scopeKey={String(win.id)}
                  conv={win.conv}
                  kind={win.kind}
                  carrier={carrier}
                  messages={galleryMessages}
                >
                  <ForwardScroll win={win} />
                </ChatMediaGallery>
              </ForwardSubRecordsProvider>
            </ForwardCarrierContext.Provider>
          </ConvContext.Provider>
        </ForwardKindContext.Provider>
      </ForwardParentContext.Provider>
    </section>
  );
}

/**
 * 把当前这一层每条记录内联的 `subMsgs` 挂成 msgId → 子记录表，供嵌套转发的预览卡
 * 直接取用（点进去时不必再查一次库）。
 */
function ForwardSubRecordsProvider({
  records,
  children,
}: {
  records: ForwardRecordWire[];
  children: ReactElement;
}): ReactElement {
  const table = useMemo(() => {
    const map = new Map<string, unknown[]>();
    for (const record of records) {
      if (record.subMsgs && record.subMsgs.length > 0) map.set(record.msgId, record.subMsgs);
    }
    return map;
  }, [records]);
  return (
    <ForwardSubRecordsContext.Provider value={table}>{children}</ForwardSubRecordsContext.Provider>
  );
}

function ForwardScroll({ win }: { win: ForwardWindowState }): ReactElement {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    // Always start at the top of the chain — keeps the chronological reading
    // order obvious (oldest forward at the top, newest at the bottom).
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [win.records]);

  if (win.loading) {
    return (
      <div className="weq-forward-body weq-forward-status">
        <LoadingIndicator />
      </div>
    );
  }
  if (win.error) {
    return (
      <div className="weq-forward-body weq-forward-status weq-forward-error">
        <span>加载失败：{win.error}</span>
      </div>
    );
  }
  const records = win.records ?? [];
  if (records.length === 0) {
    return (
      <div className="weq-forward-body weq-forward-status">
        <span>没有更多消息</span>
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="weq-forward-body">
      {records.map((record, index) => (
        <ForwardRow
          // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
          key={`${record.msgId || 'rec'}:${index}`}
          record={record}
          kind={win.kind}
        />
      ))}
    </div>
  );
}

/** 转发头像上的挂件叠加层，与 messageBubble 的 PendantOverlay 同构。 */
function PendantLayer({ widget }: { widget: ResolvedWidget }): ReactElement | null {
  if (widget.animated) {
    return <span className="weq-avatar-pendant-img" aria-hidden />;
  }
  return (
    <img
      className="weq-avatar-pendant-img"
      src={widget.url}
      alt=""
      aria-hidden
      draggable={false}
      onError={(event) => {
        event.currentTarget.style.display = 'none';
      }}
    />
  );
}

function ForwardRow({
  record,
  kind,
}: {
  record: ForwardRecordWire;
  kind: 'c2c' | 'group';
}): ReactElement {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const decorationEnabled = useContext(MsgDecorationEnabledContext);
  // 转发行都是「对方」样式,生效挂件只在作用范围 all 时叠上来。
  const { widget: activeWidget, scope: activeScope } = useActiveWidget();
  const localWidget = activeScope === 'all' ? activeWidget : null;
  const msgDec = useMsgDecoration(
    localWidget && record.decoration ? { ...record.decoration, widgetId: 0 } : record.decoration,
    rowRef,
  );
  // 炫彩只跟逐条消息字体走:生效字体的 font-family 规则只选中 .message-line（见
  // lib/dressSkin 的 fontRules），转发行根本没换上那款字，只有光效没字会很怪。
  const fontFxAttr = useBubbleFontFx(msgDec.fontFx, rowRef);
  const avatar =
    senderAvatarFromUin(record.senderUin) || record.senderInfo?.avatar?.avatarUrl || null;
  const displayName = record.sendNick || record.senderUin || record.senderUid || 'Unknown';
  const time = formatForwardTime(record.sendTime);
  const sendTimeMs = (Number(record.sendTime) || 0) * 1000;
  const widget = decorationEnabled.widget ? (localWidget ?? msgDec.widget) : null;

  // 灰条判定：放在所有 hook 之后（规则要求 hook 顺序稳定），命中就直接画成**居中
  // 一行** —— 与主面板一样没有头像 / 昵称 / 气泡，而不是把这些消息硬套进转发行。
  const gray = grayTipOf(record);
  if (gray) {
    // 灰条组件要 conversation / message 来把 uid 解析成昵称。转发窗口里没有会话成员表，
    // 但灰条自带的 nick 字段 + 发送人快照够用 —— 走与主面板完全相同的分支（拿不到
    // 成员表时它们本来就退回 nick 字段，不会凭空造名字）。
    const graySender = {
      id: record.senderUid || record.senderUin || '',
      identityLabel: 'UID',
      identityValue: record.senderUin || record.senderUid || '',
      username: record.senderUid || record.senderUin || '',
      displayName: record.sendNick || record.senderUin || record.senderUid || '',
      avatarUrl: null,
      kind: 'human' as const,
    };
    return (
      <div className="weq-forward-graytip" data-message-id={record.msgId}>
        <GrayTipLine
          gt={gray}
          conversation={forwardGrayTipConversation(kind)}
          message={{ id: record.msgId, sender: graySender } as never}
          user={graySender as never}
        />
      </div>
    );
  }

  return (
    <div
      ref={rowRef}
      className="weq-forward-row"
      data-bubble={msgDec.bubbleId || undefined}
      data-font={msgDec.fontId || undefined}
      data-fontfx={fontFxAttr}
      data-widget={widget?.animated ? widget.itemId : undefined}
    >
      <ProfileAvatar
        className="weq-identity-link weq-forward-author"
        target={{
          identity: record.senderUid || record.senderUin || '',
          uin: record.senderUin,
          name: displayName,
          avatarUrl: avatar,
        }}
      >
        <div className="weq-forward-avatar">
          {avatar ? (
            <img src={avatar} alt="" loading="lazy" />
          ) : (
            <span className="weq-forward-avatar-fallback">{displayName.slice(0, 1)}</span>
          )}
          {widget ? <PendantLayer widget={widget} /> : null}
        </div>
        <span className="weq-forward-row-name">{displayName}</span>
      </ProfileAvatar>
      <div className="weq-forward-row-main">
        <div className="weq-forward-row-meta">
          {time ? <span className="weq-forward-row-time">{time}</span> : null}
        </div>
        <ForwardBubble record={record} kind={kind} sendTimeMs={sendTimeMs} />
      </div>
    </div>
  );
}

/**
 * One forwarded message's content. Uses the same QqMessageContent component the
 * main timeline uses, so text / face / image / sticker / file / reply quote / 红包 /
 * 通话 / 在线文件 / 位置共享 / 长消息 / 机器人按钮 / 灰条 all draw identically —
 * including nested forwards, which now resolve their inline sub-records through
 * {@link ForwardSubRecordsContext} instead of a hand-rolled branch here.
 */
function ForwardBubble({
  record,
  kind,
  sendTimeMs,
}: {
  record: ForwardRecordWire;
  kind: 'c2c' | 'group';
  sendTimeMs: number;
}): ReactElement {
  void kind;
  return (
    <div className="weq-forward-bubble qq-bubble-shell">
      <QqMessageContent
        elements={record.elements as Array<{ type?: string; data?: Record<string, unknown> }>}
        sendTimeMs={sendTimeMs}
        msgId={record.msgId}
      />
    </div>
  );
}

export function ForwardWindowContent({ windows }: { windows: ForwardWindowState[] }): ReactNode {
  return windows.map((win) => <ForwardWindowFrame key={win.id} win={win} />);
}
