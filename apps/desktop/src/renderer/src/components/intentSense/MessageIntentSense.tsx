/**
 * 意图/情绪胶囊 —— 消息气泡下的呈现层。
 *
 * 两种形态共用一套 pill：
 *  • 常驻行（.weq-intent-chips，气泡 grid 的一个子元素，位于正文下方）——所有已有
 *    结果的消息均显示胶囊，待分析文本逐条显示 shimmer 占位。
 *  • 悬停弹层（.weq-intent-popover，portal + fixed，空间不足向上避让）——悬停任意消息
 *    250ms 后出现，未命中缓存时触发单条分析并显示加载态。悬停交互仿
 *    SetEmojiReactions 的「延迟开、延迟关」手法，弹层自身 pointer-events:none，
 *    不会打断气泡的 pointerleave。
 *
 * 本组件不关心数据来源 —— 一切经 {@link useIntentSenseContext}。
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useRenderDocument } from '../../lib/renderDocument';
import { useOverlayLayer } from '../../lib/overlayStack';
import { intentPopoverPosition } from '../../lib/intentPopoverPosition';
import { useTabActive } from '../RetainedTabs';
import {
  Award,
  CalendarCheck,
  CircleDot,
  CloudLightning,
  CornerDownRight,
  Crown,
  Eye,
  Hand,
  Heart,
  HelpCircle,
  Info,
  Laugh,
  MessageCircle,
  Share2,
  Smile,
  Sparkles,
  Sun,
  Loader2,
} from 'lucide-react';
import { useIntentSenseContext, type IntentAnalysis } from './context';
import '../../styles/intent-sense.css';

const INTENT_META: Record<string, { label: string; icon: typeof HelpCircle }> = {
  question: { label: '提问', icon: HelpCircle },
  request: { label: '请求', icon: Hand },
  greeting: { label: '问候', icon: Sun },
  share: { label: '分享', icon: Share2 },
  praise: { label: '夸赞', icon: Sparkles },
  vent: { label: '吐槽', icon: CloudLightning },
  joke: { label: '玩梗', icon: Laugh },
  plan: { label: '约定', icon: CalendarCheck },
  info: { label: '通知', icon: Info },
  chat: { label: '闲聊', icon: MessageCircle },
  boast: { label: '炫耀', icon: Crown },
  flattery: { label: '吹捧', icon: Award },
  banter: { label: '调侃', icon: Smile },
  perfunctory: { label: '敷衍', icon: CornerDownRight },
  gossip: { label: '吃瓜', icon: Eye },
  coquetry: { label: '撒娇', icon: Heart },
  other: { label: '其他', icon: CircleDot },
};

const EMOTION_LABELS: Record<string, string> = {
  joy: '开心',
  excitement: '兴奋',
  admiration: '赞叹',
  neutral: '平静',
  sadness: '低落',
  anger: '生气',
  anxiety: '焦虑',
  affection: '亲昵',
  fatigue: '疲惫',
  curiosity: '好奇',
  shock: '震惊',
  aggrieved: '委屈',
  irony: '反讽',
  anticipation: '期待',
  embarrassed: '尴尬',
};

function intentMeta(kind: string): { label: string; icon: typeof HelpCircle } {
  return INTENT_META[kind] ?? INTENT_META.other!;
}

function emotionLabel(kind: string): string {
  return EMOTION_LABELS[kind] ?? '平静';
}

function IntentPill({
  icon,
  label,
  emotion,
}: {
  icon: ReactNode;
  label: string;
  emotion?: string;
}) {
  return (
    <span className="weq-intent-pill" data-emotion={emotion ?? 'neutral'} title={label}>
      {icon}
      <span>{label}</span>
    </span>
  );
}

/** 分析中的 shimmer 占位（只给常驻行用）。 */
function IntentPillLoading({ width }: { width: number }) {
  return <span className="weq-intent-pill is-loading" style={{ minWidth: width }} aria-hidden />;
}

/** 一对胶囊：意图 + 情绪。 */
export function IntentChips({ result }: { result: IntentAnalysis }) {
  const intent = intentMeta(result.intent);
  const IntentIcon = intent.icon;
  return (
    <>
      <IntentPill icon={<IntentIcon size={11} strokeWidth={2.2} />} label={intent.label} />
      <IntentPill
        icon={<span className="weq-intent-emotion-dot" aria-hidden />}
        label={emotionLabel(result.emotion)}
        emotion={result.emotion}
      />
    </>
  );
}

const HOVER_OPEN_MS = 260;
const HOVER_CLOSE_MS = 120;
const POPOVER_EST_WIDTH = 220;
const POPOVER_EST_HEIGHT = 112;

function isMineBubble(bubble: HTMLElement): boolean {
  return bubble.classList.contains('mine') || Boolean(bubble.closest('.message-line.mine'));
}

/**
 * 挂进 MessageBubble 的集成点。`bubbleRef` 是气泡本体 —— 悬停监听挂在它上面
 * （组件自身不渲染包裹层，避免动气泡 DOM 结构）。
 */
export function MessageIntentSense({
  msgId,
  bubbleRef,
  analyzable,
}: {
  msgId: string;
  bubbleRef: React.RefObject<HTMLElement | null>;
  analyzable?: boolean;
}) {
  const ctx = useIntentSenseContext();
  const ownerDocument = useRenderDocument();
  const tabActive = useTabActive();
  const popoverRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<ReturnType<typeof intentPopoverPosition> | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 消费 version：新结果到达时重读本条。
  const version = ctx?.version ?? 0;
  const active = Boolean(ctx?.active && tabActive);
  const hoverActive = active && ctx?.hoverDisplay !== false;
  const persistentDisplay = ctx?.persistentDisplay !== false;
  const getAnalysis = ctx?.getAnalysis;
  const isUnavailable = ctx?.isUnavailable;
  const requestAnalysis = ctx?.requestAnalysis;
  const result = getAnalysis?.(msgId);
  const unavailable = isUnavailable?.(msgId) ?? false;
  const pending = ctx?.isPending?.(msgId) || !ctx?.settled;
  void version;

  useEffect(() => {
    const bubble = bubbleRef.current;
    if (!bubble || !hoverActive || !getAnalysis || !requestAnalysis) return;

    const shouldSuppress = (target: EventTarget | null): boolean => {
      if (bubble.classList.contains('context-active')) return true;
      if (bubble.closest('.message-line.selection-mode')) return true;
      const el = target instanceof Element ? target : null;
      if (el?.closest('.msg-reactions, .message-actions, .weq-msg-restore')) return true;
      return false;
    };

    const hasAnalyzableText = (): boolean => {
      if (getAnalysis(msgId)) return true;
      if (isUnavailable?.(msgId)) return false;
      if (analyzable !== undefined) return analyzable;
      const textEl = bubble.querySelector('.message-text, .qq-text-run');
      if (!textEl) return false;
      return (textEl.textContent ?? '').trim().length > 0 || textEl.querySelector('img') !== null;
    };

    const clearTimers = (): void => {
      if (openTimer.current) {
        clearTimeout(openTimer.current);
        openTimer.current = null;
      }
      if (closeTimer.current) {
        clearTimeout(closeTimer.current);
        closeTimer.current = null;
      }
    };

    const open = (e: PointerEvent): void => {
      if (shouldSuppress(e.target) || !hasAnalyzableText()) return;
      clearTimers();
      openTimer.current = setTimeout(() => {
        if (shouldSuppress(null) || !hasAnalyzableText()) return;
        const rect = bubble.getBoundingClientRect();
        const view = ownerDocument.defaultView;
        setAnchor(
          intentPopoverPosition(
            rect,
            { width: POPOVER_EST_WIDTH, height: POPOVER_EST_HEIGHT },
            { width: view?.innerWidth ?? 1024, height: view?.innerHeight ?? 768 },
            bubble.closest('.message-scroll')?.getBoundingClientRect(),
            isMineBubble(bubble),
          ),
        );
        if (!getAnalysis(msgId)) requestAnalysis(msgId);
      }, HOVER_OPEN_MS);
    };

    const close = (): void => {
      if (openTimer.current) {
        clearTimeout(openTimer.current);
        openTimer.current = null;
      }
      if (closeTimer.current) clearTimeout(closeTimer.current);
      closeTimer.current = setTimeout(() => setAnchor(null), HOVER_CLOSE_MS);
    };

    const closeImmediate = (): void => {
      clearTimers();
      setAnchor(null);
    };

    const onMove = (e: PointerEvent): void => {
      if (shouldSuppress(e.target)) {
        closeImmediate();
      }
    };

    bubble.addEventListener('pointerenter', open);
    bubble.addEventListener('pointerleave', close);
    bubble.addEventListener('pointermove', onMove);
    bubble.addEventListener('contextmenu', closeImmediate);
    return () => {
      bubble.removeEventListener('pointerenter', open);
      bubble.removeEventListener('pointerleave', close);
      bubble.removeEventListener('pointermove', onMove);
      bubble.removeEventListener('contextmenu', closeImmediate);
      clearTimers();
    };
  }, [
    bubbleRef,
    hoverActive,
    getAnalysis,
    isUnavailable,
    requestAnalysis,
    msgId,
    ownerDocument,
    analyzable,
  ]);

  useEffect(() => {
    setAnchor(null);
  }, [msgId, ctx?.conv, ctx?.kind, hoverActive]);

  const showPopover = hoverActive && anchor !== null && (!!result || !unavailable);
  const layer = useOverlayLayer(showPopover);
  useLayoutEffect(() => {
    const popover = popoverRef.current;
    const bubble = bubbleRef.current;
    const view = ownerDocument.defaultView;
    if (!showPopover || !popover || !bubble || !view) return;
    const area = bubble.closest('.message-scroll');
    const place = (): void => {
      const measured = popover.getBoundingClientRect();
      const next = intentPopoverPosition(
        bubble.getBoundingClientRect(),
        {
          width: popover.offsetWidth || measured.width,
          height: popover.offsetHeight || measured.height,
        },
        { width: view.innerWidth, height: view.innerHeight },
        area?.getBoundingClientRect(),
        isMineBubble(bubble),
      );
      setAnchor((current) =>
        current &&
        current.top === next.top &&
        current.left === next.left &&
        current.maxWidth === next.maxWidth &&
        current.maxHeight === next.maxHeight
          ? current
          : next,
      );
    };
    place();
    const observer = new view.ResizeObserver(place);
    observer.observe(popover);
    observer.observe(bubble);
    if (area) observer.observe(area);
    return () => observer.disconnect();
  }, [showPopover, result, bubbleRef, ownerDocument]);

  // 列表滚动或窗口失焦时立即收起 fixed 浮层，防止浮层悬空残留。
  useEffect(() => {
    if (!anchor) return;
    const view = ownerDocument.defaultView;
    const dismiss = (): void => setAnchor(null);
    ownerDocument.addEventListener('scroll', dismiss, true);
    ownerDocument.addEventListener('pointerdown', dismiss, true);
    ownerDocument.addEventListener('keydown', dismiss);
    view?.addEventListener('blur', dismiss);
    view?.addEventListener('resize', dismiss);
    view?.visualViewport?.addEventListener('resize', dismiss);
    return () => {
      ownerDocument.removeEventListener('scroll', dismiss, true);
      ownerDocument.removeEventListener('pointerdown', dismiss, true);
      ownerDocument.removeEventListener('keydown', dismiss);
      view?.removeEventListener('blur', dismiss);
      view?.removeEventListener('resize', dismiss);
      view?.visualViewport?.removeEventListener('resize', dismiss);
    };
  }, [anchor, ownerDocument]);

  if (!active) return null;

  return (
    <>
      {/* 常驻行：所有已有结果与待分析文本；本轮分析结束后仍无结果则静默
          （引擎不可用 / 纯媒体消息 / 分析失败都不再永挂 shimmer）。 */}
      {persistentDisplay && analyzable !== false && !result && pending && !unavailable ? (
        <span className="weq-intent-chips">
          <IntentPillLoading width={52} />
          <IntentPillLoading width={40} />
        </span>
      ) : null}
      {persistentDisplay && result ? (
        <span className="weq-intent-chips">
          <IntentChips result={result} />
        </span>
      ) : null}

      {/* 悬停弹层。 */}
      {showPopover && anchor
        ? createPortal(
            <div
              ref={popoverRef}
              className="weq-intent-popover"
              style={{
                top: anchor.top,
                left: anchor.left,
                maxWidth: Math.min(260, anchor.maxWidth),
                maxHeight: anchor.maxHeight,
                zIndex: layer,
              }}
              role="tooltip"
            >
              {result ? (
                <>
                  <div className="weq-intent-popover-row">
                    <IntentChips result={result} />
                  </div>
                  <div className="weq-intent-popover-row">
                    <span>情绪强度</span>
                    <span className="weq-intent-popover-bar">
                      <span style={{ width: `${Math.round(result.intensity)}%` }} />
                    </span>
                    <span>{Math.round(result.intensity)}</span>
                  </div>
                  <div className="weq-intent-popover-row">
                    <span>情感倾向</span>
                    <span className="weq-intent-popover-bar is-sentiment">
                      <span style={{ width: `${Math.round((result.sentiment + 100) / 2)}%` }} />
                    </span>
                    <span>{result.sentiment > 0 ? `+${result.sentiment}` : result.sentiment}</span>
                  </div>
                  <div className="weq-intent-popover-row">
                    <span style={{ opacity: 0.65 }}>
                      置信度 {Math.round(result.confidence * 100)}% ·{' '}
                      {result.engine === 'local' ? '本地模型' : 'API'}
                    </span>
                  </div>
                </>
              ) : (
                <div className="weq-intent-popover-row">
                  <Loader2 size={12} className="weq-spin" />
                  <span>正在分析…</span>
                </div>
              )}
            </div>,
            ownerDocument.body,
          )
        : null}
    </>
  );
}
