import {
  Fragment,
  memo,
  useCallback,
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
import { useSurfaceRemovalFade } from '../hooks/useSurfaceRemovalFade';
import { client } from '../trpc/client';
import { LoadingIndicator } from './LoadingIndicator';
import { AvatarPicture } from './AvatarPicture';
import { AvatarPendantImage } from './AvatarPendantImage';
import { QqMessageContent } from './QqMessageContent';
import {
  ConvContext,
  ForwardCarrierContext,
  ForwardKindContext,
  type ForwardCarrier,
} from '../state/messageContext';
import { GrayTipLine } from '../im-template/template/messageRow';
import { grayTipOf } from '../im-template/template/messageRow.shared';
import { MessageTimeDivider } from '../im-template/template/messageTime';
import { useMessageRowDress } from '../hooks/useMessageRowDress';
import { preferenceValue, useClientPreferences } from '../lib/clientPreferences';
import { useSurfaceEscape } from '../lib/surfaceEscape';
import type { User } from '../im-template/template/types';
import { ProfileAvatar } from './ProfileAvatar';
import { visibleViewport } from '../lib/visibleViewport';
import { ChatMediaGallery } from './ChatMediaGallery';
import { MessageProvenance, SystemMessageContent } from './MessageProvenance';
import { ForwardRecordList, type ForwardActions } from './ForwardRecordList';
import {
  forwardAuthorIsSelf,
  forwardEntries,
  forwardRecordTarget,
  forwardSenderAvatar,
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
  viewer,
}: {
  win: ForwardWindowState;
  actions?: ForwardActions;
  viewer?: User;
}): ReactElement {
  const close = useForwardStore((s) => s.close);
  const bringToFront = useForwardStore((s) => s.bringToFront);
  const move = useForwardStore((s) => s.move);
  const setRecords = useForwardStore((s) => s.setRecords);
  const setError = useForwardStore((s) => s.setError);
  const surface = useRef<HTMLElement>(null);
  const canShowExit = useCallback(
    () => !useForwardStore.getState().windows.some(({ id }) => id === win.id),
    [win.id],
  );
  useSurfaceRemovalFade(surface, { pinToViewport: true, canShow: canShowExit });
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
                kind={win.kind === 'group' ? 'group' : 'c2c'}
                carrier={carrier}
                messages={galleryMessages}
              >
                <ForwardScroll
                  win={win}
                  entries={entries}
                  actions={actions}
                  viewer={viewer}
                  groupMessages={groupMessages}
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
  viewer,
  groupMessages,
  dismissRef,
}: {
  win: ForwardWindowState;
  entries: ForwardEntry[];
  actions?: ForwardActions;
  viewer?: User;
  groupMessages: boolean;
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

  const renderRow = (entry: ForwardEntry, standalone = false) => (
    <ForwardRow
      entry={entry}
      kind={win.kind === 'group' ? 'group' : 'c2c'}
      windowId={win.id}
      mine={forwardAuthorIsSelf(entry.record, viewer)}
      interactive={Boolean(actions)}
      standalone={standalone}
    />
  );
  if (actions)
    return (
      <ForwardRecordList
        win={win}
        entries={entries}
        actions={actions}
        groupMessages={groupMessages}
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

const ForwardRow = memo(function ForwardRow({
  entry,
  kind,
  windowId,
  mine,
  interactive,
  standalone,
}: {
  entry: ForwardEntry;
  kind: 'c2c' | 'group';
  windowId: number;
  mine: boolean;
  interactive: boolean;
  standalone: boolean;
}): ReactElement {
  const { record, sendTimeMs, reply } = entry;
  const replyTargetId = reply?.targetId;
  const rowRef = useRef<HTMLDivElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const gray = grayTipOf(record);
  const dress = useMessageRowDress(gray ? undefined : record.decoration, bubbleRef, { mine });
  const avatar = forwardSenderAvatar(record);
  const displayName = forwardSenderName(record);
  const groupPosition = standalone ? undefined : entry.groupPosition;
  const continuation = !standalone && isForwardContinuation(entry);
  const metadata = {
    msgSeq: record.msgSeq === undefined ? undefined : String(record.msgSeq),
    createdAt: sendTimeMs > 0 ? new Date(sendTimeMs).toISOString() : undefined,
  };
  const profileTarget = {
    identity: record.senderUid || record.senderUin || '',
    uin: record.senderUin,
    name: displayName,
    avatarUrl: avatar,
  };

  // 灰条判定：放在所有 hook 之后（规则要求 hook 顺序稳定），命中就直接画成**居中
  // 一行** —— 与主面板一样没有头像 / 昵称 / 气泡，而不是把这些消息硬套进转发行。
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
        <SystemMessageContent message={metadata} alwaysShowTime={standalone}>
          <GrayTipLine
            gt={gray}
            conversation={forwardGrayTipConversation(kind)}
            message={{ id: record.msgId, sender: graySender } as never}
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
      data-forward-group={groupPosition}
      data-forward-continuation={continuation || undefined}
      data-message-group={dress.dressed ? undefined : groupPosition}
      data-grouped-dress-bubble={dress.dressed ? groupPosition : undefined}
      data-weq-dress-mine={mine || undefined}
      {...dress.attributes}
    >
      {continuation ? (
        <span className="sr-only" data-privacy-sensitive>
          {displayName}
        </span>
      ) : (
        <header className="weq-forward-author">
          <ProfileAvatar className="weq-forward-avatar-link" target={profileTarget}>
            <div className="weq-forward-avatar">
              <AvatarPicture className="weq-forward-avatar-face" src={avatar} />
              <AvatarPendantImage widget={dress.widget} />
            </div>
          </ProfileAvatar>
          <div className="weq-message-heading">
            <span className="message-name weq-forward-row-name" data-marquee-text>
              {displayName}
            </span>
            <MessageProvenance message={metadata} alwaysShowTime={standalone} />
          </div>
        </header>
      )}
      <div className="weq-forward-row-main">
        <div ref={bubbleRef} className="weq-forward-bubble qq-bubble-shell" data-marquee-text>
          <QqMessageContent
            elements={record.elements}
            sendTimeMs={sendTimeMs}
            msgId={record.msgId || ''}
            isSender={mine}
            // 外层会话只负责转发素材下载，不能用作原通话录音等操作的会话身份。
            conversation={{ id: '' }}
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
  viewer,
}: {
  windows: ForwardWindowState[];
  actions?: ForwardActions;
  viewer?: User;
}): ReactNode {
  return windows.map((win) => (
    <ForwardWindowFrame key={win.id} win={win} actions={actions} viewer={viewer} />
  ));
}
