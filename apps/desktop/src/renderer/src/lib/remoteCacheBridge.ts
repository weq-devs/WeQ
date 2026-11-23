type CacheAction =
  | { action: 'get' | 'getRecords'; newerThan?: number }
  | { action: 'put'; payload: string; savedAt: number }
  | {
      action: 'putRecords';
      savedAt: number;
      revision: string;
      base?: string;
      keys: string[];
      records: { key: string; payload: string }[];
    };

export function remoteCacheSupportsRecords(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window as Window & { weqRemoteBusinessRecords?: number }).weqRemoteBusinessRecords === 1
  );
}

export function remoteCacheBridge() {
  if (typeof window === 'undefined') return undefined;
  return (
    window as Window & {
      webkit?: {
        messageHandlers?: {
          weqBusinessCache?: {
            postMessage(
              message: CacheAction & { scope: string; kind: 'business' | 'avatar' | 'messages' },
            ): Promise<unknown>;
          };
        };
      };
    }
  ).webkit?.messageHandlers?.weqBusinessCache;
}

/** Local IndexedDB still uses its existing origin-qualified key. */
export function sharedAccountScope(scope: string): string | undefined {
  try {
    const [origin, value] = JSON.parse(scope);
    return origin === location.origin && typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function boundedBridgeRead(read: Promise<unknown>): Promise<string | undefined> {
  const value = await boundedBridgeReply(read);
  return typeof value === 'string' ? value : undefined;
}

export async function boundedBridgeReply(read: Promise<unknown>): Promise<unknown> {
  let timer: number | undefined;
  try {
    return await Promise.race([
      read,
      new Promise<undefined>((resolve) => {
        timer = window.setTimeout(resolve, 120);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    window.clearTimeout(timer);
  }
}
