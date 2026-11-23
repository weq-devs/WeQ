import {
  useCallback,
  useEffect,
  Fragment,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import {
  BarChart3,
  BrainCircuit,
  ClipboardCopy,
  Copy,
  Download,
  FileText,
  Forward,
  Image as ImageIcon,
  ListPlus,
  Loader2,
  Share2,
  X,
} from 'lucide-react';
import { MAX_INTENT_CONTEXT_MESSAGES } from '@weq/service/intent-context';
import type { Message } from '../im-template/template/types';
import {
  MessageContextMenu,
  type MessageContextMenuState,
} from '../im-template/template/messageContextMenu';
import { copyTextToClipboard } from '../im-template/template/clipboard';
import { MessageTimeDivider } from '../im-template/template/messageTime';
import { useMessageMarquee } from '../hooks/useMessageMarquee';
import { messageImageAvailable, useMessageImage } from '../hooks/useMessageImage';
import type { QQWriteBinding } from '../hooks/useQQWriteSession';
import { useRequestContentExport } from '../state/contentSelection.shared';
import { useForwardStore, type ForwardWindowState } from '../state/forwardWindow';
import {
  selectedMessageClipboard,
  messageContentClipboard,
  messageNodeClipboard,
  messageRichClipboard,
} from '../lib/messageClipboard';
import { originalMessageClipboard } from '../lib/originalMessageClipboard';
import { writeMentionClipboard } from '../lib/mentionClipboard';
import { messageMediaSaveSource, messageMediaTarget } from '../lib/messageMediaTarget';
import { messageForwardTarget } from '../lib/messageForwardTarget';
import { selectMessageIds, type SelectionModifiers } from '../lib/messageSelection';
import { exportMedia } from '../lib/mediaExport';
import { IS_WEB } from '../lib/target.shared';
import { client } from '../trpc/client';
import {
  forwardExportSelection,
  forwardClipboardElements,
  forwardIntentInput,
  forwardIntentText,
  forwardMessage,
  forwardTextClipboard,
  isForwardContinuation,
  type ForwardEntry,
} from '../lib/forwardRecordActions';
import { grayTipOf } from '../im-template/template/messageRow.shared';
import { ConversationActionsMenu } from './ConversationActionsMenu';
import { MessageSelectionBar } from './MessageSelectionBar';
import { MessageSelectionMark } from './MessageSelectionMark';
import { MessageMediaRevealAction } from './MessageMediaRevealAction';
import { useMediaSave } from './MediaSaveControls.shared';
import { MessageFavoriteEmojiAction } from './qq-actions/MessageFavoriteEmojiAction';
import { MessageDecorationCard } from './MessageDecorationCard';
import { MessageMenuButton } from './MessageMenuButton';
import { useToast } from './Toast.shared';
import { ForwardSelectionAnalysis } from './ForwardSelectionAnalysis';
import {
  IntentSenseContext,
  useIntentSenseStatus,
  type IntentAnalysis,
  type IntentSenseContextValue,
} from './intentSense/context.shared';

export interface ForwardActions {
  binding: QQWriteBinding | null;
  sendAvailable: boolean;
  forward(messages: Message[]): void;
  merge(messages: Message[], kind: 'c2c' | 'group'): Promise<void>;
  addMaterial(messages: Message[]): void;
}

type OpenMenu = { entry: ForwardEntry; state: MessageContextMenuState };
type CopyFormat = 'text' | 'rich' | 'json';
type IntentRun = { key: string; pending: ReadonlySet<string>; single?: string };
const EMPTY_INTENTS = new Map<string, IntentAnalysis>();
const noAnalysis = () => {};

export function ForwardRecordList({
  win,
  entries,
  actions,
  renderRow,
  dismissRef,
}: {
  win: ForwardWindowState;
  entries: ForwardEntry[];
  actions: ForwardActions;
  renderRow: (entry: ForwardEntry) => ReactNode;
  dismissRef: { current: (() => boolean) | null };
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const messageImage = useMessageImage();
  const anchor = useRef<string | null>(null);
  const [mode, setMode] = useState(false);
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set());
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [tools, setTools] = useState<{ kind: 'forward' | 'copy'; x: number; y: number } | null>(
    null,
  );
  const [report, setReport] = useState<ForwardEntry[] | null>(null);
  const [decoration, setDecoration] = useState<Message['decoration']>();
  const [merging, setMerging] = useState(false);
  const mergePending = useRef(false);
  const press = useRef<{
    pointer: number;
    x: number;
    y: number;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const suppressTouchClick = useRef(false);
  const pushToast = useToast((state) => state.push);
  const mediaSave = useMediaSave();
  const requestExport = useRequestContentExport();
  const status = useIntentSenseStatus().data;
  const intentEnabled = Boolean(
    actions.binding &&
      status?.enabled &&
      (status.engine === 'local' ? status.localReady : status.apiConfigured),
  );
  const intentKey = JSON.stringify([actions.binding, status?.analysisRevision]);
  const currentIntent = useRef(intentKey);
  const inFlight = useRef<symbol | null>(null);
  currentIntent.current = intentKey;
  useEffect(
    () => () => {
      inFlight.current = null;
    },
    [],
  );
  const [intentRun, setIntentRun] = useState<IntentRun | null>(null);
  const [intentResults, setIntentResults] = useState({ key: '', values: EMPTY_INTENTS });
  const results = intentResults.key === intentKey ? intentResults.values : EMPTY_INTENTS;
  const runningIntent = intentRun?.key === intentKey ? intentRun : null;
  const intentContext: IntentSenseContextValue = useMemo(
    () => ({
      active: intentEnabled,
      automatic: false,
      persistentDisplay: status?.persistentDisplay,
      hoverDisplay: status?.hoverDisplay,
      loadingAnimation: status?.loadingAnimation,
      manualSingleMessageId: runningIntent?.single,
      isManualPending: (id) => runningIntent?.pending.has(id) ?? false,
      version: results.size,
      getAnalysis: (id) => results.get(id),
      isUnavailable: () => false,
      requestAnalysis: noAnalysis,
      latestMessageId: null,
      latestPeerMsgId: null,
      settled: true,
      kind: win.kind,
      conv: `forward:${win.id}`,
    }),
    [intentEnabled, status, runningIntent, results, win.kind, win.id],
  );

  const orderedIds = useMemo(() => entries.map(({ id }) => id), [entries]);
  const closeMenu = useCallback(() => setMenu(null), []);
  const closeTools = useCallback(() => setTools(null), []);
  const closeReport = useCallback(() => setReport(null), []);
  const endPress = useCallback(() => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  }, []);
  useEffect(() => endPress, [endPress]);

  const exit = useCallback(() => {
    setMode(false);
    setIds(new Set());
    anchor.current = null;
    setTools(null);
  }, []);
  dismissRef.current = () => {
    if (menu) closeMenu();
    else if (tools) closeTools();
    else if (mode) exit();
    else return false;
    return true;
  };
  useEffect(
    () => () => {
      dismissRef.current = null;
    },
    [dismissRef],
  );

  function toggle(id: string, modifiers: SelectionModifiers) {
    setMode(true);
    const from = anchor.current;
    if (!modifiers.shiftKey || !from) anchor.current = id;
    setIds((old) => selectMessageIds(old, orderedIds, id, from, modifiers));
  }

  function startSelection() {
    setMode(true);
    const body = bodyRef.current;
    if (body && !body.contains(body.ownerDocument.activeElement))
      body.focus({ preventScroll: true });
  }

  const marquee = useMessageMarquee({
    conversationKey: String(win.id),
    enabled: !menu && !tools,
    selectionMode: mode,
    selected: ids,
    orderedIds,
    anchorRef: anchor,
    onChange: setIds,
    onStart: startSelection,
    onSelect: toggle,
  });
  const visibleIds = marquee.previewIds ?? ids;
  const picked = () => entries.filter(({ id }) => ids.has(id));
  const messages = (list: readonly ForwardEntry[]) =>
    list.map((entry) => forwardMessage(win, entry));
  const error = (title: string, cause: unknown) =>
    pushToast({
      tone: 'error',
      title,
      detail: cause instanceof Error ? cause.message : String(cause),
    });

  function openMenu(
    entry: ForwardEntry,
    origin: HTMLElement,
    target: EventTarget | null,
    point: { x: number; y: number },
    variant: 'desktop' | 'mobile',
  ) {
    useForwardStore.getState().bringToFront(win.id);
    const message = forwardMessage(win, entry);
    const selection = origin.ownerDocument.getSelection();
    const selected =
      selection?.rangeCount && selection.getRangeAt(0).intersectsNode(origin)
        ? selectedMessageClipboard(bodyRef.current)
        : null;
    const element = target instanceof Element ? target : null;
    const quote = element?.closest('.qq-reply-quote');
    const mediaTarget = messageMediaTarget(message, element, {
      carrier: { kind: win.kind, msgId: win.rootMsgId, resId: win.resId },
      conv: win.conv,
    });
    const imageUrl =
      target instanceof HTMLImageElement &&
      (quote || ['pic', 'emoji', 'mface'].includes(mediaTarget?.kind ?? ''))
        ? target.currentSrc || target.src
        : undefined;
    selection?.removeAllRanges();
    setMenu({
      entry,
      state: {
        message,
        ...point,
        variant,
        originElement: origin,
        forwardTarget: messageForwardTarget(message, target),
        mediaTarget,
        favoriteEmojiUrl: mediaTarget?.favoriteUrl,
        imageUrl,
        clipboard: selected ?? (quote && !imageUrl ? messageNodeClipboard(quote) : undefined),
      },
    });
  }

  function beginTouch(event: PointerEvent<HTMLDivElement>, entry: ForwardEntry) {
    endPress();
    suppressTouchClick.current = false;
    if (event.pointerType !== 'touch' || !event.isPrimary || mode) return;
    const { pointerId, clientX, clientY, target, currentTarget } = event;
    const timer = setTimeout(() => {
      press.current = null;
      suppressTouchClick.current = true;
      const { left, width, bottom } = currentTarget.getBoundingClientRect();
      openMenu(entry, currentTarget, target, { x: left + width / 2, y: bottom + 6 }, 'mobile');
    }, 500);
    press.current = { pointer: pointerId, x: clientX, y: clientY, timer };
  }

  async function copyOne({ state, entry }: OpenMenu) {
    closeMenu();
    try {
      const { message, clipboard, imageUrl } = state;
      if (imageUrl && !clipboard) {
        const result = await exportMedia({ url: imageUrl }, 'clipboard');
        if (!result.ok) throw new Error(result.error);
      } else {
        const value =
          clipboard ??
          originalMessageClipboard(
            [message],
            {
              account: actions.binding?.expectedAccountUin ?? '',
              conversation: message.conversationId,
            },
            messageContentClipboard(
              forwardClipboardElements(entry.record),
              message.body || '[消息]',
            ),
          );
        if (!(await writeMentionClipboard(value))) throw new Error('未能写入剪贴板，请重新复制。');
      }
      pushToast({ tone: 'success', title: '已复制' });
    } catch (cause) {
      error('复制失败', cause);
    }
  }

  async function copySelected(format: CopyFormat) {
    const selected = picked();
    const rows = messages(selected);
    if (!rows.length) return;
    try {
      const readable = rows.map((row, index) => ({
        ...row,
        qqElements: forwardClipboardElements(selected[index]!.record),
      }));
      const rich =
        format === 'rich'
          ? messageRichClipboard(
              readable.map((message) => ({
                sender: message.sender?.displayName || '未知用户',
                time: message.createdAt,
                body: message.body,
                elements: message.qqElements,
              })),
            )
          : { text: forwardTextClipboard(readable), html: '' };
      const copied =
        format === 'json'
          ? await copyTextToClipboard(
              JSON.stringify(
                readable.map((message) => ({
                  msgId: message.msgId ?? '',
                  senderId: message.senderId,
                  senderName: message.sender?.displayName,
                  senderUin:
                    message.sender?.identityLabel === 'QQ' ? message.sender.identityValue : '',
                  createdAt: message.createdAt,
                  body: message.body,
                  decoration: message.decoration ?? null,
                  elements: message.qqElements,
                })),
                (_key, value: unknown) => (typeof value === 'bigint' ? String(value) : value),
                2,
              ),
            )
          : await writeMentionClipboard(
              originalMessageClipboard(
                rows,
                {
                  account: actions.binding?.expectedAccountUin ?? '',
                  conversation: `forward:${win.id}`,
                },
                rich,
              ),
            );
      if (!copied) throw new Error('未能写入剪贴板，请重新复制。');
      pushToast({
        tone: 'success',
        title: `已复制 ${rows.length} 条消息${format === 'json' ? '（JSON）' : ''}`,
      });
    } catch (cause) {
      error('复制失败', cause);
    }
  }

  async function copySelectedImage() {
    const source = bodyRef.current;
    const selection = picked();
    if (!source || !selection.length || messageImage.busy) return;
    try {
      await messageImage.copy(
        source,
        selection.map((entry) => (
          <Fragment key={entry.id}>
            {entry.showTime ? <MessageTimeDivider value={entry.sendTimeMs} /> : null}
            <div
              className="weq-forward-item weq-message-selectable"
              data-forward-continuation={isForwardContinuation(entry) || undefined}
              data-weq-message-image-row
            >
              {renderRow(entry)}
            </div>
          </Fragment>
        )),
        selection.length,
      );
      pushToast({ tone: 'success', title: '已复制聊天长图' });
    } catch (cause) {
      error('复制为图片失败', cause);
    }
  }

  async function merge() {
    if (!actions.sendAvailable || mergePending.current) return;
    const rows = messages(picked());
    if (!rows.length) return;
    mergePending.current = true;
    setMerging(true);
    try {
      await actions.merge(rows, win.kind);
    } catch (cause) {
      error('准备转发失败', cause);
    } finally {
      mergePending.current = false;
      setMerging(false);
    }
  }

  async function analyze(list: ForwardEntry[]) {
    const binding = actions.binding;
    if (!intentEnabled || !binding || runningIntent) return;
    const eligible = list.filter((entry) => forwardIntentText(entry));
    if (!eligible.length) {
      pushToast({ tone: 'info', title: '所选消息没有可分析的内容' });
      return;
    }
    const run = Symbol();
    inFlight.current = run;
    const isCurrent = () => inFlight.current === run && currentIntent.current === intentKey;
    const pending = new Set(eligible.map(({ id }) => id));
    const single = list.length === 1 ? list[0]?.id : undefined;
    setIntentRun({ key: intentKey, pending, single });
    const span = Math.min(status?.analysisContextMessages ?? 0, MAX_INTENT_CONTEXT_MESSAGES);
    let succeeded = 0;
    let failure = '';
    for (const entry of eligible) {
      if (!isCurrent()) return;
      try {
        const result = await client.account.intentSense.analyzeForwardMessage.mutate({
          ...binding,
          msgId: entry.id,
          kind: win.kind,
          conv: win.conv,
          rows: entries
            .slice(Math.max(0, entry.index - span), entry.index + 1)
            .map(forwardIntentInput),
        });
        if (!isCurrent()) return;
        if (!result) throw new Error('未返回有效分析结果，请检查模型状态后重试。');
        succeeded++;
        setIntentResults((old) => ({
          key: intentKey,
          values: new Map(old.key === intentKey ? old.values : undefined).set(entry.id, result),
        }));
      } catch (cause) {
        failure = cause instanceof Error ? cause.message : String(cause);
      } finally {
        if (isCurrent()) {
          pending.delete(entry.id);
          setIntentRun(pending.size ? { key: intentKey, pending: new Set(pending), single } : null);
        }
      }
    }
    if (!isCurrent()) return;
    inFlight.current = null;
    if (list.length > 1 || failure)
      pushToast({
        tone: failure ? (succeeded ? 'warning' : 'error') : 'success',
        title: failure ? (succeeded ? '意图感知部分完成' : '意图感知失败') : '意图感知完成',
        detail: `${list.length > 1 ? `成功 ${succeeded} 条，失败 ${eligible.length - succeeded} 条，跳过 ${list.length - eligible.length} 条` : ''}${failure ? `${list.length > 1 ? '\n' : ''}${failure}` : ''}`,
      });
  }

  function exportRows(selection: Parameters<typeof forwardExportSelection>[1]) {
    const scope = forwardExportSelection(win, selection);
    if (scope) requestExport?.(scope);
  }

  function openTools(kind: 'forward' | 'copy', button: HTMLButtonElement) {
    const rect = button.getBoundingClientRect();
    setTools({ kind, x: rect.right, y: rect.top - 4 });
  }

  const media = menu?.state.mediaTarget;
  const save = media ? messageMediaSaveSource(media) : null;
  const canExport = Boolean(
    requestExport && win.exportSource && !win.exportSource.carrierId.startsWith('optimistic-'),
  );

  return (
    <IntentSenseContext.Provider value={intentContext}>
      <div
        ref={bodyRef}
        tabIndex={-1}
        className={`weq-forward-body weq-forward-selectable${marquee.dragging ? ' is-marquee-selecting' : ''}`}
        {...marquee.handlers}
        onScrollCapture={() => {
          marquee.handlers.onScrollCapture();
          endPress();
          closeMenu();
        }}
        onKeyDown={(event) => {
          if (!mode || event.nativeEvent.isComposing || !(event.metaKey || event.ctrlKey)) return;
          const key = event.key.toLowerCase();
          if (key !== 'a' && key !== 'c') return;
          if (key === 'c' && !ids.size) return;
          event.preventDefault();
          event.stopPropagation();
          if (key === 'a') setIds(new Set(orderedIds));
          else void copySelected(event.shiftKey ? 'rich' : 'text');
        }}
      >
        {entries.map((entry) => (
          <Fragment key={entry.id}>
            {entry.showTime ? <MessageTimeDivider value={entry.sendTimeMs} /> : null}
            <div
              data-message-id={entry.id}
              data-forward-continuation={isForwardContinuation(entry) || undefined}
              className={`weq-forward-item weq-message-selectable${mode ? ' selection-mode' : ''}${visibleIds.has(entry.id) ? ' is-selected' : ''}`}
              tabIndex={0}
              role="group"
              onContextMenu={(event: MouseEvent<HTMLDivElement>) => {
                event.preventDefault();
                event.stopPropagation();
                const touch = press.current !== null || suppressTouchClick.current;
                endPress();
                if (!mode && !suppressTouchClick.current) {
                  if (touch) suppressTouchClick.current = true;
                  openMenu(
                    entry,
                    event.currentTarget,
                    event.target,
                    { x: event.clientX, y: event.clientY },
                    touch ? 'mobile' : 'desktop',
                  );
                }
              }}
              onPointerDown={(event) => beginTouch(event, entry)}
              onPointerMove={(event) => {
                const start = press.current;
                if (
                  start?.pointer === event.pointerId &&
                  Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8
                )
                  endPress();
              }}
              onPointerUp={endPress}
              onPointerCancel={endPress}
              onClickCapture={(event) => {
                if (!mode && !suppressTouchClick.current) return;
                event.preventDefault();
                event.stopPropagation();
                if (suppressTouchClick.current) suppressTouchClick.current = false;
                else toggle(entry.id, event);
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                const menuKey =
                  event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10');
                const toggleKey =
                  mode &&
                  event.target === event.currentTarget &&
                  (event.key === ' ' || event.key === 'Enter');
                if ((!menuKey || mode) && !toggleKey) return;
                event.preventDefault();
                event.stopPropagation();
                if (toggleKey) toggle(entry.id, event);
                else {
                  const { left, top } = event.currentTarget.getBoundingClientRect();
                  openMenu(
                    entry,
                    event.currentTarget,
                    event.target,
                    { x: left + 8, y: top + 8 },
                    'desktop',
                  );
                }
              }}
            >
              {mode ? <MessageSelectionMark selected={visibleIds.has(entry.id)} /> : null}
              {mode ? (
                <span className="sr-only">{ids.has(entry.id) ? '已选中' : '未选中'}</span>
              ) : null}
              {renderRow(entry)}
            </div>
          </Fragment>
        ))}
        {marquee.box ? (
          <div className="weq-message-marquee" aria-hidden style={marquee.box} />
        ) : null}
      </div>
      {messageImage.portal}
      {mode && (
        <MessageSelectionBar count={visibleIds.size}>
          {intentEnabled && (
            <SelectionAction
              label="意图感知"
              disabled={!ids.size || !!runningIntent}
              run={() => void analyze(picked())}
            >
              <BrainCircuit size={17} />
            </SelectionAction>
          )}
          <SelectionAction
            label="分析所选消息"
            disabled={!ids.size}
            run={() => setReport(picked())}
          >
            <BarChart3 size={17} />
          </SelectionAction>
          {canExport && (
            <SelectionAction
              label="导出所选消息"
              disabled={!ids.size}
              run={() => exportRows(picked())}
            >
              <Download size={17} />
            </SelectionAction>
          )}
          {actions.binding && (
            <SelectionAction
              label="添加到素材库"
              disabled={!ids.size}
              run={() => actions.addMaterial(messages(picked()))}
            >
              <ListPlus size={17} />
            </SelectionAction>
          )}
          <SelectionAction
            label="转发"
            menu
            disabled={!ids.size || merging || !actions.sendAvailable}
            reason={actions.sendAvailable ? undefined : '在线能力受限，无法转发消息'}
            run={(button) => openTools('forward', button)}
          >
            <Share2 size={17} />
          </SelectionAction>
          <SelectionAction
            label="复制"
            menu
            busy={messageImage.busy}
            reason={messageImage.busy ? '正在生成聊天长图' : undefined}
            disabled={!ids.size || messageImage.busy}
            run={(button) => openTools('copy', button)}
          >
            {messageImage.busy ? <Loader2 className="spin" size={17} /> : <Copy size={17} />}
          </SelectionAction>
          <SelectionAction label="退出多选" run={exit}>
            <X size={17} />
          </SelectionAction>
        </MessageSelectionBar>
      )}
      {tools && (
        <ConversationActionsMenu
          x={tools.x}
          y={tools.y}
          dropdown="above"
          onClose={closeTools}
          label={tools.kind === 'copy' ? '复制格式' : '转发方式'}
          actions={
            tools.kind === 'copy'
              ? [
                  {
                    label: '纯文本',
                    icon: <FileText size={16} />,
                    action: () => void copySelected('text'),
                  },
                  {
                    label: '富文本',
                    icon: <Copy size={16} />,
                    action: () => void copySelected('rich'),
                  },
                  ...(messageImageAvailable()
                    ? [
                        {
                          label: '复制为图片',
                          icon: <ImageIcon size={16} />,
                          disabled: messageImage.busy,
                          action: () => void copySelectedImage(),
                        },
                      ]
                    : []),
                  {
                    label: 'JSON',
                    icon: <ClipboardCopy size={16} />,
                    action: () => void copySelected('json'),
                  },
                ]
              : [
                  { label: '合并转发', icon: <Share2 size={16} />, action: () => void merge() },
                  {
                    label: '逐条转发',
                    icon: <Forward size={16} />,
                    action: () => actions.forward(messages(picked())),
                  },
                ]
          }
        />
      )}
      {menu && (
        <MessageContextMenu
          state={menu.state}
          metadataPrecision={grayTipOf(menu.entry.record) ? undefined : 'second'}
          metadataSequence={menu.entry.record.msgSeq?.toString()}
          onClose={closeMenu}
          onCopy={() => copyOne(menu)}
          onMultiSelect={() => {
            closeMenu();
            startSelection();
            menu.state.originElement?.focus({ preventScroll: true });
            anchor.current = menu.entry.id;
            setIds(new Set([menu.entry.id]));
          }}
          onForward={(message) => {
            closeMenu();
            actions.forward([message]);
          }}
          forwardBlockedReason={actions.sendAvailable ? null : 'QQ 在线能力暂不可用'}
          onAddToComposition={
            actions.binding
              ? (message) => {
                  closeMenu();
                  actions.addMaterial([message]);
                }
              : undefined
          }
          onExport={
            canExport && menu.state.forwardTarget
              ? () => {
                  exportRows({ entry: menu.entry, card: menu.state.forwardTarget! });
                  closeMenu();
                }
              : undefined
          }
          onViewDecoration={(message) => {
            closeMenu();
            setDecoration(message.decoration);
          }}
          onSaveMedia={
            save
              ? () => {
                  closeMenu();
                  void mediaSave.run(save);
                }
              : undefined
          }
          downloadDisabled={mediaSave.disabled}
          forwardVoice={{
            carrierId: win.rootMsgId,
            kind: win.kind,
            conv: win.conv,
            resId: win.resId,
          }}
          favoriteEmojiAction={
            menu.state.favoriteEmojiUrl ? (
              <MessageFavoriteEmojiAction
                url={menu.state.favoriteEmojiUrl}
                mediaLabel={media?.label}
                onClose={closeMenu}
              />
            ) : null
          }
          revealAction={
            !IS_WEB && media && actions.binding ? (
              <MessageMediaRevealAction
                key={JSON.stringify(media)}
                target={media}
                binding={actions.binding}
                onClose={closeMenu}
              />
            ) : null
          }
          intentAction={
            intentEnabled && forwardIntentText(menu.entry) ? (
              <MessageMenuButton
                type="button"
                disabled={!!runningIntent}
                onClick={() => {
                  closeMenu();
                  void analyze([menu.entry]);
                }}
              >
                <BrainCircuit size={17} />
                <span>意图感知</span>
              </MessageMenuButton>
            ) : null
          }
        />
      )}
      {decoration && (
        <MessageDecorationCard decoration={decoration} onClose={() => setDecoration(undefined)} />
      )}
      {report && <ForwardSelectionAnalysis entries={report} onClose={closeReport} />}
    </IntentSenseContext.Provider>
  );
}

function SelectionAction({
  label,
  reason,
  disabled,
  busy,
  menu,
  run,
  children,
}: {
  label: string;
  reason?: string;
  disabled?: boolean;
  busy?: boolean;
  menu?: boolean;
  run: (button: HTMLButtonElement) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="selection-action"
      title={reason ?? label}
      aria-label={label}
      disabled={disabled}
      aria-busy={busy || undefined}
      aria-haspopup={menu ? 'menu' : undefined}
      onClick={(event) => run(event.currentTarget)}
    >
      {children}
    </button>
  );
}
