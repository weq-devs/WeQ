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

import { useContext, useMemo, type ReactElement, type ReactNode } from 'react';
import { create, useStore, type StoreApi } from 'zustand';
import type { NotificationEvent } from '@weq/service/notification-settings';
import { publishNotificationSystem } from '../lib/notificationPolicy';
import { taskNotificationPresented } from '../lib/taskNotificationPresentation';
import {
  NotificationSourceContext,
  openNotificationSource,
} from '../lib/notificationNavigation.shared';
import type { NotificationSource } from '../lib/notificationNavigation';
import {
  DEFAULT_TOAST_DURATIONS,
  normalizeToastDurations,
  type ToastDurations,
} from '@weq/service/toast-settings';
import '../styles/toast-action.css';
import '../styles/toast-layout.css';

export type ToastTone = 'info' | 'warning' | 'error' | 'success';
export type ToastDurationKind = 'success' | 'failure' | 'long';
export interface ToastAction {
  label: string;
  run: () => void;
  icon?: 'play' | 'open' | 'task' | 'conversation' | 'settings' | 'reload';
  /** 导航动作的明确目标，用于与来源入口去重；普通回调不按文案合并。 */
  source?: NotificationSource;
}

export interface Toast {
  id: number;
  event: NotificationEvent;
  /** 任务身份独立于导航来源，专用进度可继续提供会话等快捷入口。 */
  taskId?: string;
  /** 同一状态或操作的稳定标识，用于替换旧横幅及恢复后清理。 */
  key?: string;
  tone: ToastTone;
  occurredAt: number;
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
  action?: ToastAction;
  source?: NotificationSource | null;
}

/** 就地改一条已在屏上的 toast —— 长任务用它把「进行中」推进成「成功/失败」。 */
export type ToastPatch = Partial<
  Pick<
    Toast,
    | 'tone'
    | 'durationKind'
    | 'loading'
    | 'title'
    | 'detail'
    | 'ttl'
    | 'dismissible'
    | 'action'
    | 'source'
    | 'event'
  >
>;

interface ToastStore {
  durations: ToastDurations;
  setDurations(durations: ToastDurations): void;
  toasts: Toast[];
  /** 正在播放退场动画的 toast id，动画结束后才真正移除 */
  leaving: number[];
  seq: number;
  /** 推一条 toast；相同 key 原地替换，返回 id 供 `update` 推进状态。 */
  push(input: {
    event?: NotificationEvent;
    taskId?: string;
    key?: string;
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
    source?: NotificationSource | null;
    system?: false;
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
  /** 对应问题已解决，不受失败通知停留时长或悬停暂停影响。 */
  resolve(key: string): void;
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

const toastStore = create<ToastStore>((set, get) => ({
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
  push({
    event,
    taskId,
    key,
    tone = 'info',
    durationKind,
    loading,
    title,
    message,
    detail,
    ttl,
    dismissible,
    action,
    source,
    system,
  }) {
    const state = get();
    const existing = key === undefined ? undefined : state.toasts.find((item) => item.key === key);
    const id = existing?.id ?? state.seq + 1;
    // 兼容旧调用点：只传一个内容时它就是标题；传了 title 时旧 message 变成详情
    const actualTitle = title ?? message ?? '';
    const actualDetail = detail ?? (title != null ? message : undefined);
    const kind = durationKind ?? defaultDurationKind(tone, ttl);
    const toast: Toast = {
      id,
      taskId: taskId ?? (source?.target.kind === 'task' ? source.target.id : undefined),
      event:
        event ??
        (loading
          ? 'progress'
          : existing?.event === 'progress'
            ? kind === 'failure'
              ? 'taskFailure'
              : 'taskComplete'
            : kind === 'failure'
              ? 'failure'
              : 'success'),
      key,
      tone,
      occurredAt: Date.now(),
      durationKind: kind,
      loading,
      title: actualTitle,
      detail: actualDetail,
      ttl: toastTtl({ durationKind: kind, loading, dismissible, ttl }, state.durations),
      timerRevision: existing ? existing.timerRevision + 1 : 0,
      dismissible,
      action,
      source,
    };
    if (
      system !== false &&
      !taskNotificationPresented(toast.event, source, undefined, toast.taskId) &&
      (!existing ||
        existing.event !== toast.event ||
        (!loading &&
          !existing.loading &&
          (textOf(existing.title) !== textOf(actualTitle) ||
            textOf(existing.detail) !== textOf(actualDetail)))) &&
      ![
        'directMessage',
        'groupMessage',
        'specialCare',
        'mentionMe',
        'mentionAll',
        'replyMe',
        'redPacket',
        'keyword',
        'recall',
        'mail',
      ].includes(toast.event)
    )
      publishNotificationSystem(
        toast.event,
        textOf(actualTitle),
        textOf(actualDetail),
        source ? () => openNotificationSource(source) : action?.run,
      );
    set({
      seq: Math.max(state.seq, id),
      toasts: existing
        ? state.toasts.map((item) => (item.id === id ? toast : item))
        : [...state.toasts, toast],
      leaving: existing ? state.leaving.filter((item) => item !== id) : state.leaving,
    });
    return id;
  },
  update(id, patch) {
    if (!get().toasts.some((t) => t.id === id)) return;
    set({
      toasts: get().toasts.map((t) => {
        if (t.id !== id) return t;
        const next = { ...t, ...patch };
        next.event =
          patch.event ??
          (t.event === 'progress' && patch.loading === false
            ? (patch.durationKind ?? defaultDurationKind(next.tone, patch.ttl)) === 'failure'
              ? 'taskFailure'
              : 'taskComplete'
            : t.event === 'success' || t.event === 'failure'
              ? (patch.durationKind ?? defaultDurationKind(next.tone, patch.ttl)) === 'failure'
                ? 'failure'
                : 'success'
              : t.event);
        if (
          next.event !== t.event &&
          !taskNotificationPresented(next.event, next.source, undefined, next.taskId)
        )
          publishNotificationSystem(
            next.event,
            textOf(next.title),
            textOf(next.detail),
            next.source ? () => openNotificationSource(next.source!) : next.action?.run,
          );
        if (patch.tone !== undefined || patch.title !== undefined || patch.detail !== undefined)
          next.occurredAt = Date.now();
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
  resolve(key) {
    const state = get();
    const ids = state.toasts
      .filter((toast) => toast.key === key && !state.leaving.includes(toast.id))
      .map((toast) => toast.id);
    if (ids.length) set({ leaving: [...state.leaving, ...ids] });
  },
  remove(id) {
    set({
      toasts: get().toasts.filter((t) => t.id !== id),
      leaving: get().leaving.filter((lid) => lid !== id),
    });
  },
}));

/** 来源绑定在发起操作的渲染闭包中，迟到结果不读取后来切换到的页面。 */
export function sourceToastPush(source: NotificationSource): ToastStore['push'] {
  return (input) =>
    toastStore.getState().push({
      ...input,
      source:
        input.source !== undefined
          ? input.source
          : input.loading ||
              input.durationKind === 'long' ||
              input.dismissible === false ||
              input.durationKind === 'failure' ||
              input.tone === 'error' ||
              input.tone === 'warning'
            ? source
            : undefined,
    });
}

function scopedToastStore(source: NotificationSource): StoreApi<ToastStore> {
  const push = sourceToastPush(source);
  let previous: ToastStore | undefined;
  let snapshot: ToastStore;
  const getState = () => {
    const state = toastStore.getState();
    if (state !== previous) {
      previous = state;
      snapshot = { ...state, push };
    }
    return snapshot;
  };
  return { ...toastStore, getState, getInitialState: getState };
}

export const useToast = Object.assign(function useToast<T = ToastStore>(
  selector: (state: ToastStore) => T = ((state: ToastStore) => state) as (state: ToastStore) => T,
  origin?: NotificationSource | null,
): T {
  const inherited = useContext(NotificationSourceContext);
  const source = origin === undefined ? inherited : origin;
  const store = useMemo(() => (source ? scopedToastStore(source) : toastStore), [source]);
  return useStore(store, selector);
}, toastStore);

/** 仅发通知的回调不订阅横幅列表，避免进度更新反复渲染业务页面。 */
export function useToastApi(
  origin?: NotificationSource | null,
): Pick<ToastStore, 'push' | 'update' | 'dismiss' | 'resolve' | 'remove' | 'setDurations'> {
  const inherited = useContext(NotificationSourceContext);
  const source = origin === undefined ? inherited : origin;
  return useMemo(() => {
    const { push, update, dismiss, resolve, remove, setDurations } = toastStore.getState();
    return {
      push: source ? sourceToastPush(source) : push,
      update,
      dismiss,
      resolve,
      remove,
      setDurations,
    };
  }, [source]);
}

/** 尽量把 ReactNode 还原成纯文本，用于复制（拿不到字符串时返回空串）。 */
export function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object' && 'props' in node) {
    const element = node as ReactElement<{ children?: ReactNode }>;
    if (element.type === 'br') return '\n';
    const text = textOf(element.props.children);
    return typeof element.type === 'string' && /^(p|div|pre|li)$/.test(element.type)
      ? `${text}\n`
      : text;
  }
  return '';
}
