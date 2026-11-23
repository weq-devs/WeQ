import {
  Fragment,
  memo,
  useCallback,
  useContext,
  useEffect,
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
import { QqMessageContent } from './QqMessageContent';
import {
  ConvContext,
  ForwardCarrierContext,
  ForwardKindContext,
  type ForwardCarrier,
} from '../state/messageContext';
import { MsgDecorationEnabledContext } from '../state/messageAppearance';
import { GrayTipLine } from '../im-template/template/messageRow';
import { grayTipOf } from '../im-template/template/messageRow.shared';
import { MessageTimeDivider } from '../im-template/template/messageTime';
import { useMsgDecoration } from '../hooks/useMsgDecoration';
import { useActiveFontFx, useActiveWidget } from '../hooks/useActiveWidget.shared';
import { localDressApplies } from '../lib/dressSkin';
import { preferenceValue, useClientPreferences } from '../lib/clientPreferences';
import { useBubbleFontFx } from '../hooks/useBubbleFontFx';
import { useSurfaceEscape } from '../lib/surfaceEscape';
import type { ResolvedWidget } from '@weq/service';
import { ProfileAvatar } from './ProfileAvatar';
import { visibleViewport } from '../lib/visibleViewport';
import { ChatMediaGallery } from './ChatMediaGallery';
import { MessageProvenance, SystemMessageContent } from './MessageProvenance';
import { ForwardRecordList, type ForwardActions } from './ForwardRecordList';
import {
  forwardEntries,
  forwardRecordTarget,
  forwardSenderName,
  isForwardContinuation,
  type ForwardEntry,
} from '../lib/forwardRecordActions';
import { textMarkdownKey } from '../state/textMarkdown';
import { revealTimelineMessage } from '../lib/timelineViewport';
import { MessageIntentSense } from './intentSense/MessageIntentSense';

import {
  useForwardStore,
  ForwardParentContext,
  WINDOW_WIDTH,
  WINDOW_HEIGHT,
  forwardWindowStyle,
  type ForwardWindowState,
  type ForwardRecordWire,
} from '../state/forwardWindow';
import '../styles/forward-records.css';

// ---- helpers -------------------------------------------------------------

function senderAvatarFromUin(uin: string | undefined): string | null {
  if (!uin || uin === '0') return null;
  return `https://thirdqq.qlogo.cn/g?b=sdk&s=0&nk=${uin}`;
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

function ForwardWindowFrame({
  win,
  actions,
}: {
  win: ForwardWindowState;
  actions?: ForwardActions;
}): ReactElement {
  const close = useForwardStore((s) => s.close);
  const bringToFront = useForwardStore((s) => s.bringToFront);
  const move = useForwardStore((s) => s.move);
  const setRecords = useForwardStore((s) => s.setRecords);
  const setError = useForwardStore((s) => s.setError);
  const surface = useRef<HTMLElement>(null);
  const dismissBody = useRef<(() => boolean) | null>(null);
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
  useSurfaceEscape(
    surface,
    () => {
      if (!dismissBody.current?.()) close(win.id);
    },
    true,
    false,
  );

  // Initial fetch — only when no payload was injected up-front.
  useEffect(() => {
    if (win.records !== null) return;
    let cancelled = false;
    client.account.getForwardMessages
      .query({
        kind: win.kind,
        msgId: win.parentId ? 'forward-child' : win.msgId || 'forward-card',
        ...(win.resId ? { resId: win.resId } : {}),
      })
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
  }, [win.id, win.kind, win.msgId, win.resId, win.records, win.parentId, setRecords, setError]);

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

      dragStateRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        originX: win.x,
        originY: win.y,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [win.x, win.y],
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

  // 转发窗口不在聊天区的消息 provider 内——
  // 这里补上，否则窗口里的视频/文件下载既不知道群号也不知道自己是转发内容。
  const carrier = useMemo(
    (): ForwardCarrier => ({ msgId: win.rootMsgId, kind: win.kind, resId: win.resId }),
    [win.rootMsgId, win.kind, win.resId],
  );
  const groupMessages = useClientPreferences(() => preferenceValue('groupConsecutiveMessages'));
  const entries = useMemo(
    () => forwardEntries({ id: win.id, records: win.records }, groupMessages),
    [win.id, win.records, groupMessages],
  );
  const galleryMessages = useMemo(
    () =>
      entries.map(({ id, record }) => ({
        ...record,
        key: id,
        msgSeq: record.msgSeq === undefined ? undefined : String(record.msgSeq),
        sendTime: record.sendTime ?? '0',
      })),
    [entries],
  );

  return (
    <section
      ref={surface}
      tabIndex={-1}
      className="weq-forward-window"
      style={style}
      role="dialog"
      aria-label={win.title}
      onPointerDownCapture={(event) => {
        if (event.currentTarget.contains(event.target as Node)) bringToFront(win.id);
      }}
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
              <ChatMediaGallery
                scopeKey={String(win.id)}
                conv={win.conv}
                kind={win.kind}
                carrier={carrier}
                messages={galleryMessages}
              >
                <ForwardScroll
                  win={win}
                  entries={entries}
                  actions={actions}
                  dismissRef={dismissBody}
                />
              </ChatMediaGallery>
            </ForwardCarrierContext.Provider>
          </ConvContext.Provider>
        </ForwardKindContext.Provider>
      </ForwardParentContext.Provider>
    </section>
  );
}

function ForwardScroll({
  win,
  entries,
  actions,
  dismissRef,
}: {
  win: ForwardWindowState;
  entries: ForwardEntry[];
  actions?: ForwardActions;
  dismissRef: { current: (() => boolean) | null };
}): ReactElement {
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
  if (entries.length === 0) {
    return (
      <div className="weq-forward-body weq-forward-status">
        <span>没有更多消息</span>
      </div>
    );
  }

  const renderRow = (entry: ForwardEntry) => (
    <ForwardRow entry={entry} kind={win.kind} windowId={win.id} interactive={Boolean(actions)} />
  );
  if (actions)
    return (
      <ForwardRecordList
        win={win}
        entries={entries}
        actions={actions}
        renderRow={renderRow}
        dismissRef={dismissRef}
      />
    );
  return (
    <div className="weq-forward-body">
      {entries.map((entry) => (
        <Fragment key={entry.id}>
          {entry.showTime ? <MessageTimeDivider value={entry.sendTimeMs} /> : null}
          {renderRow(entry)}
        </Fragment>
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

const ForwardRow = memo(function ForwardRow({
  entry,
  kind,
  windowId,
  interactive,
}: {
  entry: ForwardEntry;
  kind: 'c2c' | 'group';
  windowId: number;
  interactive: boolean;
}): ReactElement {
  const { record, sendTimeMs, reply } = entry;
  const replyTargetId = reply?.targetId;
  const rowRef = useRef<HTMLDivElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const decorationEnabled = useContext(MsgDecorationEnabledContext);
  // 转发行都是「对方」样式，替代无装扮仍依据原始 ID 判断。
  const {
    widget: activeWidget,
    scope: activeScope,
    scopes,
    bubbleActive,
    fontActive,
  } = useActiveWidget();
  const decoration = record.decoration;
  const activeFontFx = useActiveFontFx();
  const localBubble =
    bubbleActive &&
    localDressApplies(scopes?.bubble ?? activeScope, false, Boolean(decoration?.bubbleId));
  const localFont =
    fontActive &&
    localDressApplies(scopes?.font ?? activeScope, false, Boolean(decoration?.fontId));
  const localWidget = localDressApplies(activeScope, false, Boolean(decoration?.widgetId))
    ? activeWidget
    : null;
  const msgDec = useMsgDecoration(
    decoration
      ? {
          ...decoration,
          bubbleId: localBubble ? 0 : decoration.bubbleId,
          fontId: localFont ? 0 : decoration.fontId,
          widgetId: localWidget ? 0 : decoration.widgetId,
        }
      : undefined,
    rowRef,
  );
  const fontFxAttr = useBubbleFontFx(localFont ? activeFontFx : msgDec.fontFx, rowRef);
  const avatar =
    senderAvatarFromUin(record.senderUin) || record.senderInfo?.avatar?.avatarUrl || null;
  const displayName = forwardSenderName(record);
  const continuation = isForwardContinuation(entry);
  const dressed = Boolean(msgDec.bubbleId || localBubble);
  const metadata = {
    msgSeq: record.msgSeq === undefined ? undefined : String(record.msgSeq),
    createdAt: sendTimeMs > 0 ? new Date(sendTimeMs).toISOString() : undefined,
  };
  const widget = decorationEnabled.widget ? (localWidget ?? msgDec.widget) : null;
  const profileTarget = {
    identity: record.senderUid || record.senderUin || '',
    uin: record.senderUin,
    name: displayName,
    avatarUrl: avatar,
  };

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
      <div className="weq-forward-graytip" data-message-id={interactive ? undefined : entry.id}>
        <SystemMessageContent message={metadata}>
          <GrayTipLine
            gt={gray}
            conversation={forwardGrayTipConversation(kind)}
            message={{ id: record.msgId, sender: graySender } as never}
            user={graySender as never}
          />
        </SystemMessageContent>
      </div>
    );
  }

  return (
    <div
      ref={rowRef}
      className="weq-forward-row message-line theirs"
      data-message-id={interactive ? undefined : entry.id}
      data-forward-group={entry.groupPosition}
      data-forward-continuation={continuation || undefined}
      data-message-group={dressed ? undefined : entry.groupPosition}
      data-grouped-dress-bubble={dressed ? entry.groupPosition : undefined}
      data-bubble={msgDec.bubbleId || undefined}
      data-font={msgDec.fontId || undefined}
      data-weq-system-font={msgDec.systemFont || undefined}
      data-fontfx={fontFxAttr}
      data-widget={widget?.animated ? widget.itemId : undefined}
      data-record-bubble={decoration?.bubbleId || undefined}
      data-record-font={decoration?.fontId || undefined}
      data-record-widget={decoration?.widgetId || undefined}
    >
      {continuation ? (
        <span className="sr-only" data-privacy-sensitive>
          {displayName}
        </span>
      ) : (
        <header className="weq-forward-author">
          <ProfileAvatar className="weq-forward-avatar-link" target={profileTarget}>
            <div className="weq-forward-avatar">
              {avatar ? (
                <img src={avatar} alt="" loading="lazy" />
              ) : (
                <span className="weq-forward-avatar-fallback">{displayName.slice(0, 1)}</span>
              )}
              {widget ? <PendantLayer widget={widget} /> : null}
            </div>
          </ProfileAvatar>
          <div className="weq-message-heading">
            <span className="message-name weq-forward-row-name" data-marquee-text>
              {displayName}
            </span>
            <MessageProvenance message={metadata} />
          </div>
        </header>
      )}
      <div className="weq-forward-row-main">
        <div ref={bubbleRef} className="weq-forward-bubble qq-bubble-shell" data-marquee-text>
          <QqMessageContent
            elements={record.elements}
            sendTimeMs={sendTimeMs}
            msgId={record.msgId || ''}
            galleryKey={entry.id}
            textMarkdownDisplayKey={textMarkdownKey({
              conversationId: `forward:${windowId}`,
              id: entry.id,
            })}
            forwardRecord={{
              target: forwardRecordTarget(entry),
              children: record.subMsgs,
              reply: reply && {
                senderName: reply.senderName,
                onJump: replyTargetId
                  ? () => {
                      const body = rowRef.current?.closest<HTMLElement>('.weq-forward-body');
                      if (body) revealTimelineMessage(body, replyTargetId, true);
                    }
                  : undefined,
              },
            }}
          />
        </div>
        {interactive ? (
          <MessageIntentSense msgId={entry.id} bubbleRef={bubbleRef} analyzable={false} />
        ) : null}
      </div>
    </div>
  );
});

export function ForwardWindowContent({
  windows,
  actions,
}: {
  windows: ForwardWindowState[];
  actions?: ForwardActions;
}): ReactNode {
  return windows.map((win) => <ForwardWindowFrame key={win.id} win={win} actions={actions} />);
}
