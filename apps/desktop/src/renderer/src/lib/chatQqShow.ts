/**
 * 聊天头像的 QQ 秀 URL —— 渲染层按 uin 订阅，请求自动合批。
 *
 * 每条消息都挂一个头像，如果各自 `useQuery` 会瞬间打出几十个 IPC 查询；这里改用
 * 一个模块级缓存 + 一个短窗口合批：同一轮渲染里出现的 uin 合并成一次
 * `chatQqShows` 查询（服务端串行查 QQ），结果按 uin 广播给订阅者。
 *
 * 仅可见头像订阅有效期计时；离屏后不再主动查询，失败退避后可重试。
 */
import { createContext, useEffect, useState, useSyncExternalStore, type RefObject } from 'react';
import { client } from '../trpc/client';

/** 设置里「聊天 QQ 秀替换头像」的广播值；默认关，避免无 Provider 的测试环境发请求。 */
export const ChatQqShowEnabledContext = createContext(false);
/** 与 service 的默认分钟数保持一致。 */
export const DEFAULT_CHAT_QQ_SHOW_MINUTES = 5;

interface QqShowValue {
  hasShow: boolean;
  url: string;
  expiresAt: number;
}
let emptyEntry: QqShowValue = { hasShow: false, url: '', expiresAt: 0 };

const entries = new Map<string, QqShowValue>();
const pending = new Set<string>();
const queued = new Set<string>();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;

function uinKey(uin: string | null | undefined): string {
  return uin && /^\d{5,20}$/.test(uin) ? uin : '';
}

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function schedule(): void {
  if (timer !== null) return;
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, 24);
}

async function flush(): Promise<void> {
  const batch = [...queued].slice(0, 120);
  for (const uin of batch) queued.delete(uin);
  if (queued.size > 0) schedule();
  if (batch.length === 0) return;
  const owner = generation;
  for (const uin of batch) pending.add(uin);
  try {
    const result = await client.account.dressup.chatQqShows.query({ uins: batch });
    if (owner !== generation) return;
    for (const uin of batch) {
      const value = result[uin];
      entries.set(uin, value ?? { hasShow: false, url: '', expiresAt: Date.now() + 30_000 });
    }
  } catch {
    if (owner !== generation) return;
    for (const uin of batch) {
      const old = entries.get(uin);
      entries.set(uin, {
        hasShow: old?.hasShow ?? false,
        url: old?.url ?? '',
        expiresAt: Date.now() + 30_000,
      });
    }
  } finally {
    if (owner === generation) {
      for (const uin of batch) pending.delete(uin);
      emit();
    }
  }
}

/** 缓存有效或已有在途请求时不重复查询。 */
export function requestChatQqShows(uins: Array<string | null | undefined>): void {
  let added = false;
  for (const raw of uins) {
    const uin = uinKey(raw);
    if (
      !uin ||
      (entries.get(uin)?.expiresAt ?? 0) > Date.now() ||
      pending.has(uin) ||
      queued.has(uin)
    )
      continue;
    queued.add(uin);
    added = true;
  }
  if (added) schedule();
}

/** 头像真正进入可视区域后才查询，到期时只刷新仍可见的头像。 */
export function useChatQqShow(
  uin: string | null | undefined,
  enabled: boolean,
  target: RefObject<HTMLSpanElement | null>,
): QqShowValue | undefined {
  const key = enabled ? uinKey(uin) : '';
  const [visibility, setVisibility] = useState({ key: '', visible: false });
  const visible = visibility.key === key && visibility.visible;
  const entry = useSyncExternalStore(
    subscribe,
    () => (key ? (entries.get(key) ?? emptyEntry) : undefined),
    () => undefined,
  );
  useEffect(() => {
    setVisibility((current) =>
      current.key === key && !current.visible ? current : { key, visible: false },
    );
    const element = target.current;
    if (!key || !element) return;
    const observer = new IntersectionObserver(([event]) => {
      setVisibility({ key, visible: Boolean(event?.isIntersecting) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [key, target]);
  useEffect(() => {
    if (!key || !visible) return;
    let refresh: ReturnType<typeof setTimeout>;
    const scheduleRefresh = () => {
      const wait = Math.max(0, (entry?.expiresAt ?? 0) - Date.now());
      refresh = setTimeout(
        () => {
          if (wait > 2_147_483_647) scheduleRefresh();
          else requestChatQqShows([key]);
        },
        Math.min(wait, 2_147_483_647),
      );
    };
    scheduleRefresh();
    return () => clearTimeout(refresh);
  }, [key, visible, entry]);
  return entry;
}

/** 测试 / 账号切换用：清空本次会话的请求状态。 */
export function resetChatQqShowCache(): void {
  generation += 1;
  emptyEntry = { hasShow: false, url: '', expiresAt: 0 };
  entries.clear();
  pending.clear();
  queued.clear();
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  emit();
}
