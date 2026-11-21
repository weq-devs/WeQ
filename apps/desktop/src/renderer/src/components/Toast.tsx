import { NumericText } from './NumericText';
import { preciseTimeFormatter as eventTimeFormatter } from '@weq/time';
/**
 * 右下角可展开横幅，完成态停留时间由全局设置控制。
 *
 * Layout / animation / timer behavior mirror ./tmp/demo.html:
 *   - header row: tone icon + title + actions (expand when detail exists, close)
 *   - collapsible detail body (grid 0fr -> 1fr), with a copy button
 *   - footer row: shows the remaining time (hovering the toast pauses it)
 *   - bottom progress bar driven by the remaining time
 *
 *   - useToast()    imperative store: push({ tone, title, detail })
 *   - <ToastHost/>  mounted once near the root; stacks toasts bottom-right
 *
 * Call sites historically passed `message` (and often `title` as well).
 * Backward-compatible mapping keeps every existing call working:
 *   - the single content becomes the title
 *   - `detail` (or the old `message` when a `title` was also given) becomes
 *     the expandable detail
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { useNotificationPolicy } from '../lib/notificationPolicy';
import { useWorkspaceMenu } from '../state/workspaceMenu';
import { taskNotificationPresented } from '../lib/taskNotificationPresentation';
import { openNotificationSource } from '../lib/notificationNavigation.shared';
import type { NotificationSource } from '../lib/notificationNavigation';
import { version } from '../../../../package.json';
import { IS_WEB } from '../lib/target.shared';
import { notificationInlineText, privateToastCopy } from '../../../shared/notification_copy';
import { useAppLock } from '../state/lock';
import { preferenceValue, useClientPreferences } from '../lib/clientPreferences';
import '../styles/toast-action.css';
import '../styles/toast-layout.css';
import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleX,
  Copy,
  ListTodo,
  Loader2,
  MessagesSquare,
  Play,
  RefreshCw,
  Settings2,
  X,
} from 'lucide-react';
import { type ToastTone, type ToastAction, type Toast, useToast, textOf } from './Toast.shared';

const TONE_CONFIG: Record<ToastTone, { icon: ReactElement }> = {
  info: { icon: <CircleAlert size={20} strokeWidth={2} aria-hidden /> },
  warning: { icon: <AlertTriangle size={20} strokeWidth={2} aria-hidden /> },
  error: { icon: <CircleX size={20} strokeWidth={2} aria-hidden /> },
  success: { icon: <CircleCheck size={20} strokeWidth={2} aria-hidden /> },
};

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** 退场动画时长，与横幅淡出及 .weq-toast-slot 占位收拢的 transition 保持一致。 */
const LEAVE_MS = 400;

const ACTION_ICONS = {
  reload: RefreshCw,
  open: ArrowUpRight,
  play: Play,
  task: ListTodo,
  conversation: MessagesSquare,
  settings: Settings2,
};

function sourceActionIcon(source?: NotificationSource | null): NonNullable<ToastAction['icon']> {
  if (source?.target.kind === 'task') return 'task';
  if (source?.target.kind === 'conversation' || source?.target.kind === 'generated-reply')
    return 'conversation';
  if (source?.target.kind === 'app' && source.target.target.kind === 'setting') return 'settings';
  return 'open';
}

// 目标是结构化导航参数；本地闭包只能按函数身份比较，不能序列化后误合并。
function sameActionValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => sameActionValue(a[key], b[key]));
}

function ToastRow({ toast, hidePreview }: { toast: Toast; hidePreview: boolean }): ReactElement {
  const enabled = useNotificationPolicy((state) => state.events[toast.event ?? 'success'].banner);
  const presented = useWorkspaceMenu((state) =>
    taskNotificationPresented(toast.event, toast.source, state.taskPanelScope, toast.taskId),
  );
  const visible = enabled && !presented;
  const dismiss = useToast((s) => s.dismiss);
  const remove = useToast((s) => s.remove);
  const update = useToast((s) => s.update);
  const leaving = useToast((s) => s.leaving.includes(toast.id));
  useEffect(() => {
    if (!visible && !toast.loading && toast.dismissible !== false && toast.durationKind !== 'long')
      remove(toast.id);
  }, [visible, toast.loading, toast.dismissible, toast.durationKind, toast.id, remove]);

  const [shown, setShown] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [paused, setPaused] = useState(false);
  const [timeLeft, setTimeLeft] = useState(toast.ttl);
  const [copied, setCopied] = useState(false);
  const timeLeftRef = useRef(toast.ttl);
  const copiedTimerRef = useRef<number | undefined>(undefined);

  // 进场动画：挂载后下一帧加上 show
  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // 退场动画结束后真正移除
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => remove(toast.id), LEAVE_MS);
    return () => clearTimeout(timer);
  }, [leaving, toast.id, remove]);

  // 阶段更新即重新计时，即使前后恰好使用相同的时长。
  useEffect(() => {
    timeLeftRef.current = toast.ttl;
    setTimeLeft(toast.ttl);
  }, [toast.ttl, toast.timerRevision]);

  // 倒计时引擎：每 50ms 更新一次，暂停时跳过
  useEffect(() => {
    if (leaving || toast.ttl === 0) return;
    const id = window.setInterval(() => {
      if (paused) return;
      timeLeftRef.current = Math.max(0, timeLeftRef.current - 50);
      setTimeLeft(timeLeftRef.current);
      if (timeLeftRef.current <= 0) dismiss(toast.id);
    }, 50);
    return () => window.clearInterval(id);
  }, [paused, leaving, toast.id, toast.ttl, dismiss]);

  useEffect(() => () => window.clearTimeout(copiedTimerRef.current), []);

  const privateCopy = hidePreview ? privateToastCopy(toast.event) : undefined;
  const title = privateCopy?.title ?? toast.title;
  const summary = privateCopy?.body ?? toast.summary;
  const detail = privateCopy ? undefined : toast.detail;
  const summaryText = textOf(summary).trim();
  const detailText = textOf(detail).trim();
  const repeatsDetail =
    summaryText.length > 0 &&
    notificationInlineText(detailText, summaryText.length) === summaryText;
  const hasDetail = detailText.length > 0;
  const isFailure = toast.tone === 'error' || toast.tone === 'warning';
  const hasBody = hasDetail || isFailure;
  const copyLabel = copied ? '已复制' : isFailure ? '复制错误信息' : '复制信息';

  const handleCopy = async () => {
    const text = [...new Set([textOf(title).trim(), repeatsDetail ? '' : summaryText, detailText])]
      .filter(Boolean)
      .join('\n\n');
    const occurredAt = eventTimeFormatter.format(new Date(toast.occurredAt));
    const ok = await copyText(
      isFailure
        ? [
            'WeQ 错误信息',
            `发生时间：${occurredAt}（北京时间 UTC+08:00）`,
            `界面版本：${version}`,
            `运行端：${IS_WEB ? 'Web' : '桌面端'}`,
            `运行环境：${navigator.userAgent}`,
            '',
            text,
          ].join('\n')
        : text,
    );
    if (ok) {
      setCopied(true);
      window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1200);
    }
  };

  const config = TONE_CONFIG[toast.tone];
  const progress = toast.ttl > 0 ? Math.max(0, Math.min(100, (timeLeft / toast.ttl) * 100)) : 0;
  const secondsLeft = Math.ceil(timeLeft / 1000);
  const runAction = async (run: () => unknown, keepOpen = false) => {
    try {
      await run();
      // 不播放退场动画，避免切页改变横幅锚点时已处理的通知跟着跳动。
      if (!keepOpen && !toast.loading && toast.event !== 'progress' && toast.dismissible !== false)
        remove(toast.id);
    } catch (error) {
      update(toast.id, { detail: error instanceof Error ? error.message : String(error) });
      setExpanded(true);
    }
  };
  const sameSource = Boolean(
    toast.source &&
      toast.action?.source &&
      sameActionValue(toast.source.binding, toast.action.source.binding) &&
      sameActionValue(toast.source.target, toast.action.source.target),
  );
  const action = toast.source
    ? {
        label: toast.source.label,
        source: toast.source,
        run: () => runAction(() => openNotificationSource(toast.source!)),
        icon: sameSource
          ? (toast.action?.icon ?? sourceActionIcon(toast.source))
          : sourceActionIcon(toast.source),
      }
    : toast.action
      ? { ...toast.action, run: () => runAction(toast.action!.run, toast.action!.keepOpen) }
      : undefined;
  const extraAction = toast.source && !sameSource ? toast.action : undefined;
  const ActionIcon = ACTION_ICONS[action?.icon ?? sourceActionIcon(action?.source)];
  const ExtraActionIcon = ACTION_ICONS[extraAction?.icon ?? sourceActionIcon(extraAction?.source)];

  return (
    <div className={`weq-toast-slot${leaving ? ' is-leaving' : ''}`}>
      <div
        hidden={!visible}
        data-toast-key={toast.key}
        className={`weq-toast weq-toast-${toast.tone}${shown ? ' show' : ''}${leaving ? ' fade-out' : ''}${expanded ? ' expanded' : ''}`}
        role="status"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        onPointerUp={(event) => {
          if (
            !action ||
            event.button !== 0 ||
            (event.target as Element).closest('button, a, input, textarea, select')
          )
            return;
          const selection = event.currentTarget.ownerDocument.getSelection();
          if (
            selection &&
            !selection.isCollapsed &&
            (event.currentTarget.contains(selection.anchorNode) ||
              event.currentTarget.contains(selection.focusNode))
          )
            return;
          action.run();
        }}
        onFocus={() => setPaused(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPaused(false);
        }}
      >
        {/* 第一行：标题栏 */}
        <div className="weq-toast-header">
          <div className="weq-toast-icon">
            {toast.loading ? (
              <Loader2 size={20} className="weq-spin" aria-label="加载中" />
            ) : (
              config.icon
            )}
          </div>
          <h3 className="weq-toast-title">{title}</h3>
          <div className="weq-toast-actions">
            {action ? (
              <button
                type="button"
                className="weq-toast-action weq-toast-open"
                aria-label={action.label}
                title={action.label}
                onClick={action.run}
              >
                <ActionIcon size={16} aria-hidden />
              </button>
            ) : null}
            {extraAction ? (
              <button
                type="button"
                className="weq-toast-action"
                title={extraAction.label}
                aria-label={extraAction.label}
                onClick={() => void runAction(extraAction.run, extraAction.keepOpen)}
              >
                <ExtraActionIcon size={16} aria-hidden />
              </button>
            ) : null}
            {hasBody ? (
              <button
                type="button"
                className="weq-toast-action"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                aria-label={expanded ? '折叠详情' : '展开详情'}
                title={expanded ? '折叠' : '展开'}
              >
                <ChevronDown
                  className="weq-toast-expand-icon"
                  size={16}
                  strokeWidth={2}
                  aria-hidden
                />
              </button>
            ) : null}
            {toast.dismissible !== false ? (
              <button
                type="button"
                className="weq-toast-action"
                onClick={() => dismiss(toast.id)}
                aria-label="关闭"
                title="关闭"
              >
                <X size={16} strokeWidth={2} aria-hidden />
              </button>
            ) : null}
          </div>
        </div>

        {summaryText && !(expanded && repeatsDetail) ? (
          <div className="weq-toast-summary">{summary}</div>
        ) : null}

        {/* 中间：详细内容（默认折叠） */}
        {hasBody ? (
          <div className="weq-toast-body-wrapper">
            <div className="weq-toast-body">
              <div className="weq-toast-content">
                {hasDetail ? <div className="weq-toast-detail">{detail}</div> : null}
                <button
                  type="button"
                  className="weq-toast-copy"
                  onClick={handleCopy}
                  aria-label={copyLabel}
                >
                  {copied ? (
                    <Check size={13} strokeWidth={2.2} aria-hidden />
                  ) : (
                    <Copy size={13} strokeWidth={2} aria-hidden />
                  )}
                  {copyLabel}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {/* 第二行：倒计时信息区（悬停整张卡片即可暂停） */}
        {toast.ttl > 0 ? (
          <div className="weq-toast-footer">
            <span className="weq-toast-timer-text">
              {paused ? (
                '已暂停自动关闭'
              ) : (
                <NumericText>{`将在 ${secondsLeft} 秒后关闭`}</NumericText>
              )}
            </span>

            {/*<span className={`weq-toast-timer-action${paused ? ' paused' : ''}`}>*/}
            {/*  {paused ? '移开继续' : '悬停暂停'}*/}
            {/*</span>*/}
          </div>
        ) : null}

        {/* 底部倒计时进度条 */}
        {toast.ttl > 0 ? (
          <div className="weq-toast-progress-container">
            <div className="weq-toast-progress-bar" style={{ width: `${progress}%` }} aria-hidden />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Mount once near the root. Stacks active toasts bottom-right. */
export function ToastHost(): ReactElement | null {
  const toasts = useToast((s) => s.toasts);
  const locked = useAppLock((s) => s.locked);
  const privacy = useClientPreferences(() => preferenceValue('privacyMode') === true);
  const host = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const latestId = toasts.at(-1)?.id;
  const count = toasts.length;
  useLayoutEffect(() => {
    if (count === 0) follow.current = true;
    else if (follow.current && host.current) host.current.scrollTop = host.current.scrollHeight;
  }, [count, latestId]);
  if (toasts.length === 0) return null;
  return (
    <div
      ref={host}
      className={`weq-toast-host${IS_WEB ? ' is-web' : ''}`}
      aria-live="polite"
      onScrollCapture={(event) => {
        if (event.target !== event.currentTarget) {
          follow.current = false;
          return;
        }
        const element = event.currentTarget;
        follow.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 8;
      }}
    >
      {toasts.map((t) => (
        <ToastRow key={t.id} toast={t} hidePreview={locked || privacy} />
      ))}
    </div>
  );
}
export type { ToastTone, ToastDurationKind, ToastPatch, ToastAction } from './Toast.shared';
