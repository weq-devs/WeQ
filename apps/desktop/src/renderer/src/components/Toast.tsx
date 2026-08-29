/**
 * Expandable toasts — bottom-right, auto-dismiss after 10s.
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
  AlertTriangle,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleX,
  Copy,
  X,
} from 'lucide-react';

export type ToastTone = 'info' | 'warning' | 'error' | 'success';

interface Toast {
  id: number;
  tone: ToastTone;
  /** 标题（第一行主内容） */
  title: ReactNode;
  /** 可选的详情，传入后显示展开按钮与复制按钮 */
  detail?: ReactNode;
  /** Auto-dismiss delay in ms（默认 10 秒） */
  ttl: number;
}

interface ToastStore {
  toasts: Toast[];
  /** 正在播放退场动画的 toast id，动画结束后才真正移除 */
  leaving: number[];
  seq: number;
  push(input: {
    tone?: ToastTone;
    /** 标题；兼容旧调用点的 message */
    title?: ReactNode;
    /** 旧写法的主内容，未传 title 时当作标题 */
    message?: ReactNode;
    /** 可选的详情（展开区域） */
    detail?: ReactNode;
    ttl?: number;
  }): void;
  /** 触发退场动画（自动过期 / 点击关闭） */
  dismiss(id: number): void;
  /** 退场动画结束后真正移除 */
  remove(id: number): void;
}

export const useToast = create<ToastStore>((set, get) => ({
  toasts: [],
  leaving: [],
  seq: 0,
  push({ tone = 'info', title, message, detail, ttl = 10000 }) {
    const id = get().seq + 1;
    // 兼容旧调用点：只传一个内容时它就是标题；传了 title 时旧 message 变成详情
    const actualTitle = title ?? message ?? '';
    const actualDetail = detail ?? (title != null ? message : undefined);
    set({
      seq: id,
      toasts: [...get().toasts, { id, tone, title: actualTitle, detail: actualDetail, ttl }],
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

  // 倒计时引擎：每 50ms 更新一次，暂停时跳过
  useEffect(() => {
    if (leaving) return;
    const id = window.setInterval(() => {
      if (paused) return;
      timeLeftRef.current = Math.max(0, timeLeftRef.current - 50);
      setTimeLeft(timeLeftRef.current);
      if (timeLeftRef.current <= 0) dismiss(toast.id);
    }, 50);
    return () => window.clearInterval(id);
  }, [paused, leaving, toast.id, dismiss]);

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
      <div className="weq-toast-header">
        <div className="weq-toast-icon">{config.icon}</div>
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
          <button
            type="button"
            className="weq-toast-action"
            onClick={() => dismiss(toast.id)}
            aria-label="关闭"
            title="关闭"
          >
            <X size={16} strokeWidth={2} aria-hidden />
          </button>
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
      <div className="weq-toast-footer">
        <span className="weq-toast-timer-text">
          {paused ? '已暂停自动关闭' : `将在 ${secondsLeft} 秒后关闭`}
        </span>
        <span className={`weq-toast-timer-action${paused ? ' paused' : ''}`}>
          {paused ? '移开继续' : '悬停暂停'}
        </span>
      </div>

      {/* 底部倒计时进度条 */}
      <div className="weq-toast-progress-container">
        <div className="weq-toast-progress-bar" style={{ width: `${progress}%` }} aria-hidden />
      </div>
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
