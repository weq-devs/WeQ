/**
 * 聊天头像的 QQ 秀 URL —— 渲染层按 uin 订阅，请求自动合批。
 *
 * 每条消息都挂一个头像，如果各自 `useQuery` 会瞬间打出几十个 IPC 查询；这里改用
 * 一个模块级缓存 + 一个短窗口合批：同一轮渲染里出现的 uin 合并成一次
 * `chatQqShows` 查询（服务端再按并发 3 去查 QQ），结果按 uin 广播给订阅者。
 *
 * 服务端已经维护了 uin → URL 的本地映射（含有效期），所以这里的请求失败不需要重试，
 * 失败的 uin 在本次会话里不再打扰；本地缓存命中时服务端不会联网。
 */
import { createContext, useEffect, useSyncExternalStore } from 'react';
import { client } from '../trpc/client';

/** 设置里「聊天 QQ 秀替换头像」的广播值；默认关，避免无 Provider 的测试环境发请求。 */
export const ChatQqShowEnabledContext = createContext(false);
/** 渲染层展示用的默认有效期，与 service 的 DEFAULT_QQ_SHOW_CACHE_DAYS 保持一致。 */
export const DEFAULT_CHAT_QQ_SHOW_DAYS = 14;

interface QqShowValue {
  hasShow: boolean;
  url: string;
}

const entries = new Map<string, QqShowValue>();
const failed = new Set<string>();
const queued = new Set<string>();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

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
  const batch = [...queued];
  queued.clear();
  if (batch.length === 0) return;
  try {
    const result = await client.account.dressup.chatQqShows.query({ uins: batch });
    for (const uin of batch) {
      const value = result[uin];
      if (value) entries.set(uin, value);
      else failed.add(uin);
    }
  } catch {
    // 离线 / 风控 / 未打开账号：静默回退到普通头像，等下次进程再试。
    for (const uin of batch) failed.add(uin);
  } finally {
    emit();
  }
}

/** 请求一批 uin 的 QQ 秀；同一会话内已失败或已缓存的 uin 不会重复请求。 */
export function requestChatQqShows(uins: Array<string | null | undefined>): void {
  let added = false;
  for (const raw of uins) {
    const uin = uinKey(raw);
    if (!uin || entries.has(uin) || failed.has(uin) || queued.has(uin)) continue;
    queued.add(uin);
    added = true;
  }
  if (added) schedule();
}

/** 订阅某个 uin 的 QQ 秀 URL；`enabled` 为假时不发请求。 */
export function useChatQqShow(uin: string | null | undefined, enabled: boolean): string {
  const key = enabled ? uinKey(uin) : '';
  const url = useSyncExternalStore(
    subscribe,
    () => (key ? (entries.get(key)?.url ?? '') : ''),
    () => '',
  );
  useEffect(() => {
    if (key) requestChatQqShows([key]);
  }, [key]);
  return url;
}

/** 测试 / 账号切换用：清空本次会话的请求状态。 */
export function resetChatQqShowCache(): void {
  entries.clear();
  failed.clear();
  queued.clear();
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  emit();
}
