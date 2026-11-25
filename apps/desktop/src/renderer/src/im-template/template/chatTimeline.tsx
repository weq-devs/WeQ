import {
  Component,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  type Key,
  type ReactNode,
  type RefObject,
} from 'react';
import { normalizeChatMessagePrewarmMiB } from '@weq/service/chat-message-prewarm';
import { useVirtualTimeline } from '../../hooks/useVirtualTimeline';
import { estimateTimelineRowHeight } from '../../lib/timelinePreload';
import { estimateTimelinePrewarmBytes } from '../../lib/timelinePrewarm';
import { IS_ELECTRON } from '../../lib/target.shared';
import { deletionIdentity } from '../../lib/messageDeletion';
import type { Message } from './types';
import { messageTimelineSpacing, type MessageGroupPosition } from './chatTimelineModel';
import { timelineViewport, TIMELINE_MESSAGE_SELECTOR } from '../../lib/timelineViewport';
import { restoreReadingPosition } from '../../lib/conversationReadingPosition';
import { allowsLayoutMotion, RowLayoutMotion, visibleLayoutRows } from '../../lib/layoutMotion';
import { surfaceMotionTiming } from '../../lib/surfaceMotion';
import { MessageLayoutContext } from '../../lib/messageLayout';

export type TimelineVisibility = {
  syncRows: () => void;
  dispose: () => void;
};

type TimelineRowCache = Map<number, { key: Key; node: ReactNode }>;

type ChatTimelineProps = {
  messages: Message[];
  gaps: ReadonlyMap<string, { id: string }>;
  groupPositions?: readonly (MessageGroupPosition | undefined)[];
  orderedIds: string[];
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  scope: string;
  active: boolean;
  live: boolean;
  followLive: boolean;
  pinnedToLatest: RefObject<boolean>;
  keepLatestInView: () => void;
  loading: boolean;
  jumpRevision?: number;
  deleted: ReadonlySet<string>;
  isHidden: (id: string) => boolean;
  unreadBoundary?: string;
  prewarmBudgetMiB?: number;
  ownSenderId: string;
  observeMessageVisibility: () => TimelineVisibility | undefined;
  children: (
    timeline: Pick<
      ReturnType<typeof useVirtualTimeline>,
      'enabled' | 'items' | 'measure' | 'prewarmEnabled'
    >,
    captureContent: (element: HTMLDivElement | null) => void,
    rowSpacing: (index: number) => number,
    preview: ReactNode,
    rowCache: TimelineRowCache,
  ) => ReactNode;
};

const messageKey = (message: Message) => message.outgoingId ?? message.timelineKey ?? message.id;
const timelineRow = (element: HTMLElement) =>
  element.closest<HTMLDivElement>('.weq-virtual-timeline-row');
const timelineKey = (element: HTMLElement) => timelineRow(element)?.dataset.weqMotionKey;

type VisibleRows = ReturnType<typeof visibleLayoutRows>;
type DetailLayout = {
  scroll: HTMLDivElement;
  scope: string;
  jumpRevision?: number;
  rows: VisibleRows;
  atEnd: boolean;
  revision: number | undefined;
  changes: Map<string, Set<string>>;
  animateLayout: boolean;
  followingArrival?: boolean;
};

// 抓取正文而不是虚拟行顶；同一行内部的缺口和未读分隔也会推移正文。
class ChatTimelineTransition extends Component<ChatTimelineProps> {
  private readonly motion = new RowLayoutMotion();
  private detailLayout?: DetailLayout;
  private switchFrame?: Animation;
  /**
   * 切换会话后等待「目标会话正文」落位的标记。
   *
   * `ids` 是切换前消息区里已有的消息 id：模板层换会话时会先用新会话的上下文重投影旧窗口
   * 数据（正文和 `conversationId` 都会变），所以只能看 DOM 里真正出现了哪些消息，
   * 不能拿消息字段判断。超时自动放弃，避免空会话把标记一直挂着、误伤之后的新消息。
   */
  private pendingSwitch?: { scope: string; ids: Set<string>; timer: ReturnType<typeof setTimeout> };

  private queueDetails(
    layout: Omit<DetailLayout, 'changes' | 'animateLayout'>,
    key: string,
    selectors: string[],
    animateLayout = true,
  ) {
    let pending = this.detailLayout;
    if (!pending) {
      pending = this.detailLayout = { ...layout, changes: new Map(), animateLayout };
      queueMicrotask(() => this.applyDetails());
    }
    pending.animateLayout ||= animateLayout;
    const changed = pending.changes.get(key) ?? new Set<string>();
    for (const selector of selectors) changed.add(selector);
    pending.changes.set(key, changed);
  }

  /**
   * 切会话的「内容落位」：消息区整块换成新会话的正文后，从略低的不透明度 + 4px 下位上浮。
   *
   * 为什么不在 scope 变化的那一刻播：切换瞬间消息区里还挂着上一个会话的正文（窗口数据
   * 换 key 要等查询回来才提交），那时淡入的是旧内容，真正的新内容反而硬切进来，
   * 看起来就像「闪了一下」。这里等到出现属于目标会话的消息再播。
   */
  private settleConversation() {
    const { active, scope, scrollRef } = this.props;
    const pending = this.pendingSwitch;
    if (!pending || pending.scope !== scope || !active) return;
    const scroll = scrollRef.current;
    if (!scroll) return;
    if (!this.hasFreshRows(scroll, pending.ids)) return;
    this.clearPendingSwitch();
    if (!allowsLayoutMotion(scroll)) return;
    // 连点/连续键切换时上一段还在播：让它继续淡完，别把不透明度重新拉回去闪一下。
    if (this.switchFrame?.playState === 'running') return;
    this.switchFrame = scroll.animate(
      [
        { opacity: 0.45, transform: 'translateY(4px)' },
        { opacity: 1, transform: 'none' },
      ],
      { duration: surfaceMotionTiming.settle, easing: surfaceMotionTiming.easing },
    );
    void this.switchFrame.finished.catch(() => {});
  }

  /**
   * 消息区里渲染出来的消息是否**全部**换成了切换前没有的（新会话的正文已经落位）。
   *
   * 用「全部」而不是「出现一条」：切换期间如果旧会话恰好来了一条新消息，那一条也是新 id，
   * 但它不代表新会话的正文到了，不能拿来做落位信号。
   */
  private hasFreshRows(scroll: HTMLElement, previousIds: Set<string>) {
    const rows = scroll.querySelectorAll<HTMLElement>(TIMELINE_MESSAGE_SELECTOR);
    if (!rows.length) return false;
    for (const element of rows) {
      const id = element.dataset.messageId;
      if (!id || previousIds.has(id)) return false;
    }
    return true;
  }

  private clearPendingSwitch() {
    if (this.pendingSwitch) clearTimeout(this.pendingSwitch.timer);
    this.pendingSwitch = undefined;
  }

  /** 在 DOM 被替换前记下当前消息 id，切换后据此判断新正文是否已经落位。 */
  private beginPendingSwitch(scope: string) {
    this.clearPendingSwitch();
    const scroll = this.props.scrollRef.current;
    if (!this.props.active || !scroll) return;
    const ids = new Set<string>();
    for (const element of scroll.querySelectorAll<HTMLElement>(TIMELINE_MESSAGE_SELECTOR)) {
      const id = element.dataset.messageId;
      if (id) ids.add(id);
    }
    const timer = setTimeout(() => {
      this.pendingSwitch = undefined;
    }, 3000);
    this.pendingSwitch = { scope, ids, timer };
  }

  private captureDetails = (element: HTMLElement, selectors: string[], animateLayout: boolean) => {
    const { scrollRef, scope, jumpRevision, active, loading } = this.props;
    const scroll = scrollRef.current;
    const row = timelineRow(element);
    const key = row?.dataset.weqMotionKey;
    if (!active || loading || !scroll?.clientHeight || !row || key === undefined) return;
    const viewport = timelineViewport(scroll);
    if (viewport?.isUserScrolling?.()) return;
    if (this.detailLayout) {
      if (this.detailLayout.rows.has(key))
        this.queueDetails(this.detailLayout, key, selectors, animateLayout);
      return;
    }
    const bounds = scroll.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    if (rect.height === 0 || rect.bottom <= bounds.top || rect.top >= bounds.bottom) return;
    this.queueDetails(
      {
        scroll,
        scope,
        jumpRevision,
        rows: visibleLayoutRows(scroll, TIMELINE_MESSAGE_SELECTOR, timelineKey, bounds),
        atEnd: this.props.live && this.props.pinnedToLatest.current,
        revision: viewport?.scrollRevision?.(),
      },
      key,
      selectors,
      animateLayout,
    );
  };

  private applyDetails() {
    const layout = this.detailLayout;
    this.detailLayout = undefined;
    if (!layout) return;
    const { scroll, scope, rows, atEnd, changes, followingArrival } = layout;
    if (
      !this.props.active ||
      this.props.loading ||
      this.props.scope !== scope ||
      this.props.jumpRevision !== layout.jumpRevision ||
      this.props.scrollRef.current !== scroll
    )
      return;
    const viewport = timelineViewport(scroll);
    if (
      viewport?.isUserScrolling?.() ||
      (!followingArrival && layout.revision !== viewport?.scrollRevision?.())
    )
      return;

    const mounted = new Map<string, HTMLElement>();
    const affected = new Set<HTMLDivElement>();
    let lastChanged: string | undefined;
    let anchor: string | undefined;
    let resized = false;
    for (const element of scroll.querySelectorAll<HTMLElement>(TIMELINE_MESSAGE_SELECTOR)) {
      const wrapper = timelineRow(element);
      const key = wrapper?.dataset.weqMotionKey;
      if (!wrapper || key === undefined || !rows.has(key)) continue;
      mounted.set(key, element);
      if (changes.has(key)) {
        affected.add(wrapper);
        lastChanged = key;
        anchor = undefined;
        const old = rows.get(key)!;
        resized ||= Math.abs(old.bottom - old.top - element.getBoundingClientRect().height) >= 1;
      } else if (lastChanged !== undefined && anchor === undefined) {
        anchor = key;
      }
    }
    if (lastChanged === undefined) return;
    if (resized) {
      if (!followingArrival) this.motion.stop();
      if (scroll.classList.contains('is-virtualized')) viewport?.measureRows?.(affected);
      if (!followingArrival) {
        if (atEnd) {
          this.props.keepLatestInView();
        } else {
          // 优先固定下一条的上沿，消息分组或行间距变化时也能保住下方内容。
          const key = anchor ?? lastChanged;
          const old = rows.get(key)!;
          restoreReadingPosition(scroll, {
            anchorId: mounted.get(key)!.dataset.messageId,
            alignToEnd: anchor === undefined,
            bottomInset: scroll.clientHeight - old.bottom,
            offset: old.top,
            scrollTop: scroll.scrollTop,
          });
        }
      }
    }
    if (!allowsLayoutMotion(scroll)) return;
    const top = scroll.getBoundingClientRect().top;
    for (const [key, element] of mounted) {
      const wrapper = timelineRow(element)!;
      const selectors = changes.get(key);
      if (resized && !followingArrival && layout.animateLayout) {
        const offset = rows.get(key)!.top - (element.getBoundingClientRect().top - top);
        this.motion.shift(wrapper, offset, scroll.clientHeight, selectors !== undefined);
      }
      for (const selector of selectors ?? []) {
        const detail = selector ? wrapper.querySelector<HTMLElement>(selector) : element;
        if (detail) this.motion.reveal(detail);
      }
      if (key === lastChanged) break;
    }
  }

  override getSnapshotBeforeUpdate(previous: ChatTimelineProps) {
    // 必须在 DOM 被替换前读：切换后消息区会先挂着旧窗口的正文，之后才换成新会话的。
    if (this.props.scope !== previous.scope) this.beginPendingSwitch(this.props.scope);
    const {
      active,
      scope,
      gaps,
      scrollRef,
      messages,
      loading,
      live,
      followLive,
      pinnedToLatest,
      jumpRevision,
      deleted,
      isHidden,
      unreadBoundary,
    } = this.props;
    const scroll = scrollRef.current;
    if (!active || !previous.active || scope !== previous.scope || !scroll?.clientHeight)
      return null;
    const edits =
      !loading &&
      !previous.loading &&
      jumpRevision === previous.jumpRevision &&
      (messages !== previous.messages ||
        deleted !== previous.deleted ||
        isHidden !== previous.isHidden ||
        unreadBoundary !== previous.unreadBoundary);
    const changed = new Set<string>();
    const changedGapIds = new Set<string>();
    if (gaps !== previous.gaps) {
      for (const [id, gap] of previous.gaps) {
        if (gaps.get(id)?.id === gap.id) continue;
        changed.add(id);
        changedGapIds.add(gap.id);
      }
      for (const [id, gap] of gaps) if (previous.gaps.get(id)?.id !== gap.id) changed.add(id);
    }
    if (!changed.size && !edits) return null;
    const bounds = scroll.getBoundingClientRect();
    const rows = visibleLayoutRows(scroll, TIMELINE_MESSAGE_SELECTOR, timelineKey, bounds);
    const states = new Map(
      [...rows].map(([key, { element }]) => [key, timelineRow(element)?.dataset.weqMotionState]),
    );
    const removed =
      edits &&
      [...rows.values()].some(
        ({ element }) =>
          isHidden(element.dataset.messageId!) && !previous.isHidden(element.dataset.messageId!),
      );
    const removedVisibleGap =
      changedGapIds.size > 0 &&
      visibleLayoutRows(
        scroll,
        '.weq-gap-band-button',
        (button) => {
          const id = button.closest<HTMLElement>('[data-message-id]')?.dataset.messageId;
          return id && changedGapIds.has(id) ? id : undefined;
        },
        bounds,
      ).size > 0;
    const atEnd = live && pinnedToLatest.current;
    const viewport = timelineViewport(scroll);
    let tail: readonly Message[] = [];
    if (
      edits &&
      live &&
      previous.live &&
      followLive &&
      pinnedToLatest.current &&
      !viewport?.isUserScrolling?.() &&
      allowsLayoutMotion(scroll) &&
      messages !== previous.messages
    ) {
      const last = previous.messages.at(-1);
      const index = last
        ? messages.findLastIndex((message) => messageKey(message) === messageKey(last))
        : -1;
      const appended = messages.length - index - 1;
      // 不把大批同步、整窗切换或解除隐藏当作新的实时气泡。
      if ((!last || index >= 0) && appended > 0 && appended <= 3)
        tail = messages.slice(index + 1).filter(({ id }) => !previous.isHidden(id));
    }
    return {
      rows,
      states,
      edits,
      removed,
      changed,
      removedVisibleGap,
      tail,
      revision: viewport?.scrollRevision?.(),
      atEnd,
    };
  }

  override componentDidUpdate(
    previous: ChatTimelineProps,
    _state: unknown,
    snapshot: ReturnType<ChatTimelineTransition['getSnapshotBeforeUpdate']>,
  ) {
    const { active, scope, loading, live, jumpRevision, messages, scrollRef, unreadBoundary } =
      this.props;
    const scroll = scrollRef.current;
    if (scope !== previous.scope) {
      this.switchFrame?.cancel();
      this.switchFrame = undefined;
    }
    // 正文落位通常伴随 messages/loading 变化；只在内容真的变了时查一次 DOM。
    if (messages !== previous.messages || loading !== previous.loading) this.settleConversation();
    if (
      !active ||
      scope !== previous.scope ||
      jumpRevision !== previous.jumpRevision ||
      loading ||
      (scroll && !allowsLayoutMotion(scroll))
    )
      this.motion.stop();
    if (!snapshot || !scroll) return;
    const viewport = timelineViewport(scroll);
    const mounted = new Map<string, HTMLElement>();
    const affectedRows = new Set<HTMLDivElement>();
    const reveal = new Map<string, HTMLElement>();
    let edited = snapshot.removed;
    let unreadMoved = false;
    const tailKeys = new Set(snapshot.tail.map(messageKey));
    for (const element of scroll.querySelectorAll<HTMLElement>(TIMELINE_MESSAGE_SELECTOR)) {
      const wrapper = timelineRow(element);
      const key = wrapper?.dataset.weqMotionKey;
      if (!wrapper || key === undefined) continue;
      mounted.set(key, element);
      const id = element.dataset.messageId!;
      if (snapshot.changed.has(id)) affectedRows.add(wrapper);
      if (!snapshot.edits) continue;
      const state = wrapper.dataset.weqMotionState;
      const old = snapshot.rows.get(key);
      const previousState = snapshot.states.get(key);
      if (old && previousState !== state && (previousState || state)) {
        this.queueDetails(
          { ...snapshot, scroll, scope, jumpRevision },
          key,
          state === 'deleted'
            ? ['.weq-msg-deleted-veil']
            : state === 'recalled'
              ? ['.weq-msg-recall-tag']
              : state === 'recall-tip'
                ? ['']
                : [],
        );
      }
      if (
        !old &&
        !tailKeys.has(key) &&
        (previous.isHidden(id) ||
          (state === 'recall-tip' &&
            live &&
            previous.live &&
            !previous.messages.some((message) => messageKey(message) === key)))
      ) {
        edited = true;
        affectedRows.add(wrapper);
        reveal.set(key, element);
      }
      if (
        unreadBoundary !== previous.unreadBoundary &&
        !tailKeys.has(key) &&
        (id === unreadBoundary || id === previous.unreadBoundary)
      ) {
        unreadMoved = true;
        affectedRows.add(wrapper);
        const divider = wrapper.querySelector<HTMLElement>('.weq-unread-divider');
        if (divider && !reveal.has(key)) reveal.set(key, divider);
      }
    }
    const reflow = snapshot.changed.size > 0 || edited || unreadMoved;
    if (reflow || tailKeys.size) this.motion.stop();
    if (tailKeys.size && scroll.classList.contains('is-virtualized')) {
      // 本次追加前的最后一行也会增加行间距。导航贴底前交付实际行高。
      const last = previous.messages.at(-1);
      for (const key of last ? [messageKey(last), ...tailKeys] : tailKeys) {
        const element = mounted.get(key);
        const row = element && timelineRow(element);
        if (row) affectedRows.add(row);
      }
    }
    if (reflow) {
      const anchor = [...snapshot.rows].find(([key]) => mounted.has(key));
      const anchorElement = anchor && mounted.get(anchor[0]);
      // 同帧交付新行高，别等下一轮 ResizeObserver 才补偿阅读位置。
      if (edited || unreadMoved) {
        for (const key of snapshot.rows.keys()) {
          const element = mounted.get(key);
          const wrapper = element && timelineRow(element);
          if (wrapper) affectedRows.add(wrapper);
        }
      }
      const anchorRow = anchorElement && timelineRow(anchorElement);
      viewport?.measureRows?.(
        affectedRows,
        !snapshot.atEnd && anchorElement && snapshot.changed.has(anchorElement.dataset.messageId!)
          ? anchorRow
          : null,
      );
      if (snapshot.revision !== viewport?.scrollRevision?.()) return;
      if (snapshot.atEnd) this.props.keepLatestInView();
      if (
        anchor &&
        anchorElement &&
        !tailKeys.size &&
        !snapshot.atEnd &&
        !viewport?.isUserScrolling?.()
      ) {
        restoreReadingPosition(scroll, {
          anchorId: anchorElement.dataset.messageId,
          offset: anchor[1].top,
          scrollTop: scroll.scrollTop,
        });
      }
    } else if (affectedRows.size) {
      viewport?.measureRows?.(affectedRows);
    }
    if (!snapshot.atEnd && snapshot.revision !== viewport?.scrollRevision?.()) return;
    if (
      loading ||
      jumpRevision !== previous.jumpRevision ||
      !allowsLayoutMotion(scroll) ||
      viewport?.isUserScrolling?.()
    )
      return;
    const oldIds = snapshot.removedVisibleGap ? new Set(previous.messages.map(messageKey)) : null;
    if (reflow) {
      const visible = visibleLayoutRows(scroll, TIMELINE_MESSAGE_SELECTOR, timelineKey);
      const fillsGap = oldIds && [...visible.keys()].some((key) => !oldIds.has(key));
      const shiftLimit = snapshot.removed
        ? Math.max(72, Math.min(144, scroll.clientHeight / 4))
        : 72;
      let fadedAfterRemoval = 0;
      for (const [key, { element, top }] of visible) {
        const old = snapshot.rows.get(key);
        const hint = reveal.get(key);
        // 补回大段历史时不让旧消息滑过新内容，也不反复量动画中的行高。
        if (
          old &&
          !tailKeys.size &&
          !fillsGap &&
          hint !== element &&
          (edited || snapshot.changed.size > 0)
        ) {
          const shift = old.top - top;
          this.motion.shift(element, shift, shiftLimit);
          if (snapshot.removed && !hint && shift > shiftLimit && fadedAfterRemoval < 2) {
            this.motion.reveal(element);
            fadedAfterRemoval++;
          }
        }
        if (hint) this.motion.reveal(hint);
        else if (oldIds && !oldIds.has(key)) this.motion.reveal(element);
      }
    }
    if (!tailKeys.size) return;
    if (this.detailLayout) this.detailLayout.followingArrival = true;
    // 等父层完成实际贴底再读取最终位置，仍在同一次绘制前启动过渡。
    queueMicrotask(() => {
      if (
        scrollRef.current !== scroll ||
        scope !== this.props.scope ||
        messages !== this.props.messages ||
        jumpRevision !== this.props.jumpRevision ||
        !this.props.active ||
        this.props.loading ||
        !allowsLayoutMotion(scroll) ||
        viewport?.isUserScrolling?.()
      )
        return;
      this.props.keepLatestInView();
      const viewportTop = scroll.getBoundingClientRect().top;
      const limit = scroll.clientHeight;
      let offset = 8;
      const shifts: Array<{ row: HTMLElement; distance: number }> = [];
      for (const [key, { top }] of snapshot.rows) {
        const element = mounted.get(key);
        const row = element && timelineRow(element);
        if (!element?.isConnected || !row) continue;
        const distance = top - (element.getBoundingClientRect().top - viewportTop);
        shifts.push({ row, distance });
        if (distance <= limit) offset = Math.max(offset, distance);
      }
      for (const { row, distance } of shifts) this.motion.shift(row, distance, limit);
      for (const key of tailKeys) {
        const element = mounted.get(key);
        const row = element && timelineRow(element);
        if (element?.isConnected && row && !snapshot.rows.has(key))
          this.motion.enterRow(row, offset);
      }
    });
  }

  override componentWillUnmount() {
    this.motion.stop();
    this.switchFrame?.cancel();
    this.switchFrame = undefined;
    this.clearPendingSwitch();
    this.detailLayout = undefined;
  }

  override render() {
    return (
      <MessageLayoutContext.Provider value={this.captureDetails}>
        <ChatTimelineContent {...this.props} />
      </MessageLayoutContext.Provider>
    );
  }
}

export function ChatTimeline(props: ChatTimelineProps) {
  return <ChatTimelineTransition {...props} />;
}

const PREVIEW_VIEWPORTS = 32;
const PREVIEW_ROWS_PER_SIDE = 256;

function renderScrollPreview(
  timeline: ReturnType<typeof useVirtualTimeline>,
  messages: readonly Message[],
  deleted: ReadonlySet<string>,
  ownSenderId: string,
) {
  const { virtualizer, items, margin } = timeline;
  const range = virtualizer.range;
  const height = virtualizer.scrollRect?.height;
  const first = items[0];
  if (!range || !height || !first || !('size' in first)) return null;
  const geometry = virtualizer.measurementsCache;
  const origin = geometry[first.index];
  if (!origin) return null;
  const shift = first.start - origin.start - margin;
  const distance = height * PREVIEW_VIEWPORTS;
  const start = Math.max(
    range.startIndex - PREVIEW_ROWS_PER_SIDE,
    virtualizer.getVirtualItemForOffset(geometry[range.startIndex]!.start - distance)?.index ?? 0,
  );
  const end = Math.min(
    range.endIndex + PREVIEW_ROWS_PER_SIDE,
    virtualizer.getVirtualItemForOffset(geometry[range.endIndex]!.end + distance)?.index ??
      messages.length - 1,
  );
  const firstPreview = geometry[start];
  const lastPreview = geometry[end];
  if (!firstPreview || !lastPreview) return null;
  const mounted = new Set(items.map(({ index }) => index));
  const previews: ReactNode[] = [];
  for (let index = start; index <= end; index++) {
    if (mounted.has(index)) continue;
    const row = geometry[index];
    const message = messages[index];
    if (!row || !message) continue;
    const text =
      message.deletedKind || deleted.has(deletionIdentity(message.id))
        ? '已删除消息'
        : message.recall
          ? '已撤回消息'
          : message.body.slice(0, 200).trim() || '媒体消息';
    previews.push(
      <div
        key={row.key}
        className="weq-timeline-scroll-preview-row"
        data-self={message.senderId === ownSenderId || undefined}
        data-privacy-sensitive
        style={{ top: row.start - firstPreview.start, maxHeight: Math.min(32, row.size) }}
      >
        {text}
      </div>,
    );
  }
  if (!previews.length) return null;
  return (
    <div className="weq-timeline-scroll-preview-clip" aria-hidden="true" inert>
      <div
        className="weq-timeline-scroll-preview"
        style={{ top: firstPreview.start + shift, height: lastPreview.end - firstPreview.start }}
      >
        {previews}
      </div>
    </div>
  );
}

function ChatTimelineContent({
  messages,
  groupPositions,
  orderedIds,
  scrollRef,
  contentRef,
  scope,
  active,
  prewarmBudgetMiB,
  deleted,
  ownSenderId,
  observeMessageVisibility,
  children,
}: ChatTimelineProps) {
  const ids = useMemo(() => messages.map(({ id }) => id), [messages]);
  const keys = useMemo(() => messages.map(messageKey), [messages]);
  const rowSpacing = useCallback(
    (index: number) =>
      messageTimelineSpacing(groupPositions?.[index], index === messages.length - 1),
    [groupPositions, messages.length],
  );
  const estimatedHeights = useMemo(
    () => messages.map((message, index) => estimateTimelineRowHeight(message) + rowSpacing(index)),
    [messages, rowSpacing],
  );
  const estimateSize = useCallback(
    (index: number) => estimatedHeights[index] ?? 96,
    [estimatedHeights],
  );
  const pixelRatio = globalThis.devicePixelRatio || 1;
  const warmBytesAt = useMemo(() => {
    const sizes = new Map<number, number>();
    return (index: number) => {
      const cached = sizes.get(index);
      if (cached !== undefined) return cached;
      const bytes = estimateTimelinePrewarmBytes(messages[index]!, pixelRatio);
      sizes.set(index, bytes);
      return bytes;
    };
  }, [messages, pixelRatio]);
  const timeline = useVirtualTimeline({
    ids,
    keys,
    orderedIds,
    scrollRef,
    scope,
    active,
    estimateSize,
    warmBytesAt,
    warmBudgetBytes: normalizeChatMessagePrewarmMiB(prewarmBudgetMiB) * 1024 * 1024,
  });
  // 纯滚动只改变列表范围。完整行的布局和内容沿用父组件这次生成的节点。
  const rowCache = useMemo<TimelineRowCache>(
    () => new Map(),
    [children, rowSpacing, timeline.measure],
  );
  useLayoutEffect(() => {
    const mounted = new Set(timeline.items.map(({ index }) => index));
    for (const index of rowCache.keys()) if (!mounted.has(index)) rowCache.delete(index);
  }, [rowCache, timeline.items]);
  const { containerRef } = timeline;
  const captureContent = useCallback(
    (element: HTMLDivElement | null) => {
      contentRef.current = element;
      containerRef(element);
    },
    [contentRef, containerRef],
  );
  const renderedItems = timeline.enabled ? timeline.items : null;
  const visibility = useRef<TimelineVisibility | undefined>(undefined);
  useLayoutEffect(
    () => () => {
      visibility.current?.dispose();
      visibility.current = undefined;
    },
    [observeMessageVisibility],
  );
  useLayoutEffect(() => {
    // 父层布局 effect 可能会先定位到底部或恢复阅读位置，再据此报告可见消息。
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      if (!visibility.current) visibility.current = observeMessageVisibility();
      visibility.current?.syncRows();
    });
    return () => {
      cancelled = true;
    };
  }, [observeMessageVisibility, renderedItems]);
  // 完整行尚未挂载的位置用简化正文兜底。
  const preview =
    IS_ELECTRON && active && timeline.enabled
      ? renderScrollPreview(timeline, messages, deleted, ownSenderId)
      : null;
  return children(timeline, captureContent, rowSpacing, preview, rowCache);
}
