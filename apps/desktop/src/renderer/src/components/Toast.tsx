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

import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { create } from 'zustand';
import {
  DEFAULT_TOAST_DURATIONS,
  normalizeToastDurations,
  type ToastDurations,
} from '@weq/service/toast-settings';
import '../styles/toast-action.css';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleX,
  Copy,
  Loader2,
  X,
} from 'lucide-react';

export type ToastTone = 'info' | 'warning' | 'error' | 'success';
export type ToastDurationKind = 'success' | 'failure' | 'long';

interface Toast {
  id: number;
  tone: ToastTone;
  /** 计时分类与视觉 tone 独立，long 沿用长期任务原有时长。 */
  durationKind: ToastDurationKind;
  loading?: boolean;
  /** 标题（第一行主内容） */
  title: ReactNode;
  /** 可选的详情，传入后显示展开按钮与复制按钮 */
  detail?: ReactNode;
  /** 自动关闭毫秒数，0 表示常驻；所有短期横幅遵循成功／失败设置。 */
  ttl: number;
  timerRevision: number;
  /** 进行中的发送任务仅提供停止按钮，避免误关进度后继续静默发送。 */
  dismissible?: boolean;
  /** 整条横幅的主操作；关闭、展开和内部按钮仍独立操作。 */
  action?: { label: string; run: () => void };
}

/** 就地改一条已在屏上的 toast —— 长任务用它把「进行中」推进成「成功/失败」。 */
export type ToastPatch = Partial<
  Pick<
    Toast,
    'tone' | 'durationKind' | 'loading' | 'title' | 'detail' | 'ttl' | 'dismissible' | 'action'
  >
>;

interface ToastStore {
  durations: ToastDurations;
  setDurations(durations: ToastDurations): void;
  toasts: Toast[];
  /** 正在播放退场动画的 toast id，动画结束后才真正移除 */
  leaving: number[];
  seq: number;
  /** 推一条 toast，返回它的 id（之后可用 `update` 就地推进状态）。 */
  push(input: {
    tone?: ToastTone;
    durationKind?: ToastDurationKind;
    loading?: boolean;
    /** 标题；兼容旧调用点的 message */
    title?: ReactNode;
    /** 旧写法的主内容，未传 title 时当作标题 */
    message?: ReactNode;
    /** 可选的详情（展开区域） */
    detail?: ReactNode;
    ttl?: number;
    dismissible?: boolean;
    action?: Toast['action'];
  }): number;
  /**
   * 原地更新一条 toast（不重播进场、不改变堆叠顺序）。
   *
   * 结束阶段按成功／失败偏好重新计时；长期任务仍保留原有 ttl。
   * id 已经不在栈里（被关掉/已过期）时静默忽略。
   */
  update(id: number, patch: ToastPatch): void;
  /** 触发退场动画（自动过期 / 点击关闭） */
  dismiss(id: number): void;
  /** 退场动画结束后真正移除 */
  remove(id: number): void;
}

function toastTtl(
  toast: Pick<Toast, 'durationKind' | 'loading' | 'dismissible'> & { ttl?: number },
  durations: ToastDurations,
): number {
  if (toast.loading || toast.dismissible === false || toast.durationKind === 'long')
    return toast.ttl ?? 0;
  const seconds =
    toast.durationKind === 'success' ? durations.successSeconds : durations.failureSeconds;
  return seconds === -1 ? 0 : seconds * 1000;
}

function defaultDurationKind(tone: ToastTone, ttl?: number): ToastDurationKind {
  // 兼容旧调用点中明确常驻的普通提示，不把用户设置产生的 ttl=0 当作长期任务。
  if (tone === 'info' && ttl === 0) return 'long';
  return tone === 'warning' || tone === 'error' ? 'failure' : 'success';
}

export const useToast = create<ToastStore>((set, get) => ({
  durations: { ...DEFAULT_TOAST_DURATIONS },
  setDurations(input) {
    const durations = normalizeToastDurations(input);
    const before = get().durations;
    if (
      before.successSeconds === durations.successSeconds &&
      before.failureSeconds === durations.failureSeconds
    )
      return;
    set({
      durations,
      toasts: get().toasts.map((toast) => {
        const ttl = toastTtl(toast, durations);
        return ttl === toast.ttl
          ? toast
          : { ...toast, ttl, timerRevision: toast.timerRevision + 1 };
      }),
    });
  },
  toasts: [],
  leaving: [],
  seq: 0,
  push({ tone = 'info', durationKind, loading, title, message, detail, ttl, dismissible, action }) {
    const id = get().seq + 1;
    // 兼容旧调用点：只传一个内容时它就是标题；传了 title 时旧 message 变成详情
    const actualTitle = title ?? message ?? '';
    const actualDetail = detail ?? (title != null ? message : undefined);
    const kind = durationKind ?? defaultDurationKind(tone, ttl);
    set({
      seq: id,
      toasts: [
        ...get().toasts,
        {
          id,
          tone,
          durationKind: kind,
          loading,
          title: actualTitle,
          detail: actualDetail,
          ttl: toastTtl({ durationKind: kind, loading, dismissible, ttl }, get().durations),
          timerRevision: 0,
          dismissible,
          action,
        },
      ],
    });
    return id;
  },
  update(id, patch) {
    if (!get().toasts.some((t) => t.id === id)) return;
    set({
      toasts: get().toasts.map((t) => {
        if (t.id !== id) return t;
        const next = { ...t, ...patch };
        const reset =
          patch.tone !== undefined ||
          patch.ttl !== undefined ||
          patch.loading !== undefined ||
          patch.dismissible !== undefined ||
          patch.durationKind !== undefined;
        next.durationKind =
          patch.durationKind ??
          (reset ? defaultDurationKind(next.tone, patch.ttl) : t.durationKind);
        return {
          ...next,
          ttl: toastTtl(next, get().durations),
          timerRevision: t.timerRevision + (reset ? 1 : 0),
        };
      }),
    });
  },
  dismiss(id) {
    if (get().leaving.includes(id)) return;
    set({ leaving: [...get().leaving, id] });
  },
  remove(id) {
    set({
      toasts: get().toasts.filter((t) => t.id !== id),
      leaving: get().leaving.filter((lid) => lid !== id),
    });
  },
}));

const TONE_CONFIG: Record<ToastTone, { icon: ReactElement }> = {
  info: { icon: <CircleAlert size={20} strokeWidth={2} aria-hidden /> },
  warning: { icon: <AlertTriangle size={20} strokeWidth={2} aria-hidden /> },
  error: { icon: <CircleX size={20} strokeWidth={2} aria-hidden /> },
  success: { icon: <CircleCheck size={20} strokeWidth={2} aria-hidden /> },
};

/** 尽量把 ReactNode 还原成纯文本，用于复制（拿不到字符串时返回空串）。 */
function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object' && 'props' in node) {
    return textOf((node as { props?: { children?: ReactNode } }).props?.children);
  }
  return '';
}

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

/** 退场动画时长，与 CSS 里 .weq-toast.fade-out 的 transition 保持一致。 */
const LEAVE_MS = 400;

function ToastRow({ toast }: { toast: Toast }): ReactElement {
  const dismiss = useToast((s) => s.dismiss);
  const remove = useToast((s) => s.remove);
  const leaving = useToast((s) => s.leaving.includes(toast.id));

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

  const hasDetail = toast.detail != null && textOf(toast.detail).length > 0;

  const handleCopy = async () => {
    const ok = await copyText(textOf(toast.detail));
    if (ok) {
      setCopied(true);
      window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1200);
    }
  };

  const config = TONE_CONFIG[toast.tone];
  const progress = toast.ttl > 0 ? Math.max(0, Math.min(100, (timeLeft / toast.ttl) * 100)) : 0;
  const secondsLeft = Math.ceil(timeLeft / 1000);

  return (
    <div
      className={`weq-toast weq-toast-${toast.tone}${shown ? ' show' : ''}${leaving ? ' fade-out' : ''}${expanded ? ' expanded' : ''}`}
      role="status"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPaused(false);
      }}
    >
      {/* 第一行：标题栏 */}
      {toast.action ? (
        <button
          type="button"
          className="weq-toast-open"
          aria-label={toast.action.label}
          title={toast.action.label}
          onClick={toast.action.run}
        />
      ) : null}
      <div className="weq-toast-header">
        <div className="weq-toast-icon">
          {toast.loading ? (
            <Loader2 size={20} className="weq-spin" aria-label="加载中" />
          ) : (
            config.icon
          )}
        </div>
        <h3 className="weq-toast-title">{toast.title}</h3>
        <div className="weq-toast-actions">
          {hasDetail ? (
            <button
              type="button"
              className="weq-toast-action"
              onClick={() => setExpanded((v) => !v)}
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

      {/* 中间：详细内容（默认折叠） */}
      {hasDetail ? (
        <div className="weq-toast-body-wrapper">
          <div className="weq-toast-body">
            <div className="weq-toast-content">
              <div className="weq-toast-detail">{toast.detail}</div>
              <button
                type="button"
                className="weq-toast-copy"
                onClick={handleCopy}
                aria-label={copied ? '已复制' : '复制详情'}
              >
                {copied ? (
                  <Check size={13} strokeWidth={2.2} aria-hidden />
                ) : (
                  <Copy size={13} strokeWidth={2} aria-hidden />
                )}
                {copied ? '已复制' : '复制'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* 第二行：倒计时信息区（悬停整张卡片即可暂停） */}
      {toast.ttl > 0 ? (
        <div className="weq-toast-footer">
          <span className="weq-toast-timer-text">
            {paused ? '已暂停自动关闭' : `将在 ${secondsLeft} 秒后关闭`}
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
  );
}

/** Mount once near the root. Stacks active toasts bottom-right. */
export function ToastHost(): ReactElement | null {
  const toasts = useToast((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="weq-toast-host" aria-live="polite">
      {toasts.map((t) => (
        <ToastRow key={t.id} toast={t} />
      ))}
    </div>
  );
}
