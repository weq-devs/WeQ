type CacheAction =
  | { action: 'get'; newerThan?: number }
  | { action: 'put'; payload: string; savedAt: number };

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
  let timer: number | undefined;
  try {
    const value = await Promise.race([
      read,
      new Promise<undefined>((resolve) => {
        timer = window.setTimeout(resolve, 120);
      }),
    ]);
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  } finally {
    window.clearTimeout(timer);
  }
}
