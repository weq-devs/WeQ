/** 让期限同时覆盖响应头和正文；不依赖自定义下载服务一定响应 AbortSignal。 */
export function waitWithSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
export async function readResponseBytes(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  check?: () => void,
): Promise<Buffer> {
  if (!response.body) throw new Error('媒体响应没有正文');
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    if (Number(response.headers.get('content-length') ?? 0) > maxBytes)
      throw new Error('媒体超过大小上限');
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      check?.();
      const chunk = await waitWithSignal(reader.read(), signal);
      signal.throwIfAborted();
      check?.();
      if (chunk.done) return Buffer.concat(chunks, size);
      size += chunk.value.byteLength;
      if (size > maxBytes) throw new Error('媒体超过大小上限');
      chunks.push(chunk.value);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
