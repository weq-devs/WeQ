import superjson from 'superjson';
import { accountGatewayResource } from './accountGateway';
import { isRemoteClient } from './remoteClient';
import { sharedAccountScope } from './remoteCacheBridge';
import { remoteWorkspaceCheckPending } from './remoteWorkspaceCheck';
import { useWebConnection } from '../state/webConnection';

const endpoint = '/_weq-remote-local/cache';
export const cacheMiB = 1024 * 1024;

export interface RemoteDataCacheStatus {
  bytes: number;
  limit: number;
  generation: string;
  cleared: boolean;
}

let account: string | undefined;
let initialStatus: Promise<RemoteDataCacheStatus | undefined> | undefined;
let latestStatus: RemoteDataCacheStatus | undefined;
let writing = Promise.resolve();
let queuedBytes = 0;
let clearing = false;

export function bindRemoteDataCache(scope: string): () => void {
  if (!isRemoteClient() || scope.startsWith('profiles:')) return () => {};
  const binding = sharedAccountScope(scope);
  account = binding;
  return () => {
    if (account === binding) account = undefined;
  };
}

export const remoteDataCacheAccount = () => account;
export function remoteDataCacheOffline() {
  return (
    remoteWorkspaceCheckPending() ||
    navigator.onLine === false ||
    useWebConnection.getState().status !== 'connected'
  );
}

async function requestStatus(method: 'GET' | 'PUT' | 'DELETE', limit?: number) {
  const response = await fetch(limit === undefined ? endpoint : `${endpoint}?limit=${limit}`, {
    method,
    cache: 'no-store',
  });
  if (!response.ok || response.headers.get('x-weq-data-cache') !== '1') return undefined;
  return (await response.json()) as RemoteDataCacheStatus;
}

export function remoteDataCacheStatus() {
  if (!isRemoteClient()) return Promise.resolve(undefined);
  initialStatus ??= requestStatus('GET')
    .then((status) => (latestStatus = status))
    .catch(() => undefined);
  return initialStatus;
}

export const currentRemoteDataCacheStatus = () => latestStatus;

export const refreshRemoteDataCacheStatus = () => requestStatus('GET');
export async function syncRemoteDataCacheLimit() {
  if (!(await remoteDataCacheStatus()) || clearing) return;
  const status = await refreshRemoteDataCacheStatus();
  if (status && !clearing && status.generation === latestStatus?.generation) {
    latestStatus = status;
    initialStatus = Promise.resolve(status);
  }
}

export function stopRemoteDataCacheWrites() {
  clearing = true;
}

export async function setRemoteDataCacheLimit(limit: number) {
  const status = await requestStatus('PUT', limit);
  if (!status) throw new Error('本机缓存上限保存失败');
  latestStatus = status;
  initialStatus = Promise.resolve(status);
  return status;
}

export async function clearRemoteDataCache() {
  stopRemoteDataCacheWrites();
  try {
    const status = await requestStatus('DELETE');
    if (!status) throw new Error('本机缓存清理失败');
    latestStatus = status;
    initialStatus = Promise.resolve(status);
    return status;
  } catch (error) {
    clearing = false;
    throw error;
  }
}

async function cacheId(key: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function recordUrl(key: string) {
  return `${endpoint}/${await cacheId(key)}`;
}

async function queriesUrl(scope: string) {
  return `${endpoint}/queries/${await cacheId(scope)}`;
}

export async function getRemoteCacheQueries<T>(scope: string): Promise<T[] | undefined> {
  if (clearing) return undefined;
  try {
    const response = await fetch(await queriesUrl(scope), { cache: 'no-store' });
    if (response.ok && response.headers.get('x-weq-data-cache') === '1') {
      const entries: unknown[] = await response.json();
      return entries.map((entry) =>
        superjson.deserialize<T>(entry as Parameters<typeof superjson.deserialize>[0]),
      );
    }
  } catch {
    // 损坏或被系统回收的缓存按缺失处理。
  }
  return undefined;
}

export function putRemoteCacheQueries<T>(
  scope: string,
  entries: T[],
  key: (entry: T) => string,
  status: RemoteDataCacheStatus,
) {
  if (!entries.length) return Promise.resolve(true);
  const payload = new Blob(
    [
      JSON.stringify(
        entries.map((entry) => ({ key: key(entry), value: superjson.serialize(entry) })),
      ),
    ],
    { type: 'application/json' },
  );
  return enqueueWrite(() => queriesUrl(scope), payload, status.generation);
}

export async function getRemoteCacheRecord<T>(key: string): Promise<T | undefined> {
  if (clearing || !(await remoteDataCacheStatus())) return undefined;
  try {
    const response = await fetch(await recordUrl(key), { cache: 'no-store' });
    if (response.ok && response.headers.get('x-weq-data-cache') === '1')
      return superjson.parse<T>(await response.text());
  } catch {
    // 缓存失败不妨碍继续请求电脑。
  }
  return undefined;
}

function enqueueWrite(url: () => Promise<string>, payload: Blob, generation: string) {
  if (clearing) return Promise.resolve(false);
  // 这里只限制在途内存；落盘保留由本机统一预算决定。
  if (queuedBytes + payload.size > Math.max(16 * cacheMiB, payload.size))
    return Promise.resolve(false);
  queuedBytes += payload.size;
  const result = writing
    .then(async () => {
      if (clearing) return false;
      const target = await url();
      const send = () =>
        fetch(target, {
          method: 'PUT',
          headers: { 'Content-Type': payload.type, 'X-WeQ-Cache-Generation': generation },
          body: payload,
        });
      const response = await send();
      if (response.status !== 409 || clearing) return response.ok;
      await new Promise((resolve) => setTimeout(resolve, 120));
      return !clearing && (await send()).ok;
    })
    .catch(() => false)
    .finally(() => {
      queuedBytes -= payload.size;
    });
  writing = result.then(() => {});
  return result;
}

export function putRemoteCacheRecord(key: string, value: unknown, status: RemoteDataCacheStatus) {
  if (clearing) return Promise.resolve(false);
  const payload = new Blob([superjson.stringify(value)], { type: 'application/json' });
  if (payload.size + 512 > status.limit) return Promise.resolve(false);
  return enqueueWrite(() => recordUrl(key), payload, status.generation);
}

export function remoteCachedResource(url: string) {
  url = accountGatewayResource(url);
  if (!isRemoteClient() || !/^\/_(?:media|asset|avatar)\//.test(url)) return url;
  const path = new URL(url, location.origin);
  const scope = path.pathname.startsWith('/_asset/') ? 'assets' : account;
  if (!scope) return url;
  if (!path.searchParams.has('weqCacheScope')) path.searchParams.set('weqCacheScope', scope);
  return `${path.pathname}${path.search}${path.hash}`;
}

export async function readRemoteCachedMedia(source: string, signal?: AbortSignal) {
  const url = remoteCachedResource(source);
  if (!url.includes('weqCacheScope=') || !(await remoteDataCacheStatus())) return undefined;
  try {
    const response = await fetch(`${endpoint}/media?${new URLSearchParams({ source: url })}`, {
      signal,
    });
    if (response.ok && response.headers.get('x-weq-data-cache') === '1')
      return {
        blob: await response.blob(),
        storedAt: Number(response.headers.get('x-weq-cache-stored-at')),
      };
  } catch {}
  return undefined;
}

export function putRemoteCachedMedia(source: string, blob: Blob, status: RemoteDataCacheStatus) {
  const url = remoteCachedResource(source);
  if (
    !url.includes('weqCacheScope=') ||
    new URL(url, location.origin).searchParams.get('weqCacheScope') !== account ||
    blob.size + 512 > status.limit
  )
    return Promise.resolve(false);
  return enqueueWrite(
    async () => `${endpoint}/media?${new URLSearchParams({ source: url })}`,
    blob,
    status.generation,
  );
}
