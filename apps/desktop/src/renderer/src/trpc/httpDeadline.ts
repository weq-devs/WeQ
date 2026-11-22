export const HTTP_RPC_TIMEOUT_MS = 120_000;

/** 超时覆盖正文消费；写请求的未知终态交回调用方，不自动重发。 */
export async function fetchRpcWithDeadline(
  input: RequestInfo | URL,
  init?: RequestInit,
  mutation = false,
): Promise<Response> {
  const controller = new AbortController();
  const parent = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const abort = () => controller.abort(parent?.reason);
  parent?.addEventListener('abort', abort, { once: true });
  if (parent?.aborted) abort();
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error(mutation ? '请求超时，操作结果暂未确认，请刷新核对。' : '请求超时，请稍后重试。'),
      ),
    HTTP_RPC_TIMEOUT_MS,
  );
  let interrupt!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    interrupt = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', interrupt, { once: true });
    if (controller.signal.aborted) interrupt();
  });
  const cleanup = () => {
    clearTimeout(timer);
    parent?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', interrupt);
  };
  try {
    const work = fetch(input, { ...init, signal: controller.signal, credentials: 'same-origin' });
    void work.then(
      (res) => {
        if (controller.signal.aborted) void res.body?.cancel().catch(() => {});
      },
      () => {},
    );
    const response = await Promise.race([work, interrupted]);
    controller.signal.removeEventListener('abort', interrupt);
    if (!response.body) {
      cleanup();
      return response;
    }
    const reader = response.body.getReader();
    const stopReading = (reason: unknown) => {
      void reader.cancel(reason).catch(() => {});
      reader.releaseLock();
    };
    let ended = false;
    let abortBody: () => void;
    const finish = () => {
      ended = true;
      cleanup();
      controller.signal.removeEventListener('abort', abortBody);
    };
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        // 正文共享一次取消监听，避免每个数据块都在同一个间断 Promise 上留下回调。
        abortBody = () => {
          if (ended) return;
          finish();
          stream.error(controller.signal.reason);
          stopReading(controller.signal.reason);
        };
        controller.signal.addEventListener('abort', abortBody, { once: true });
        if (controller.signal.aborted) abortBody();
      },
      async pull(stream) {
        if (ended) return;
        try {
          const chunk = await reader.read();
          if (ended) return;
          if (chunk.done) {
            finish();
            reader.releaseLock();
            stream.close();
          } else stream.enqueue(chunk.value);
        } catch (error) {
          if (ended) return;
          finish();
          stopReading(error);
          stream.error(error);
        }
      },
      cancel(reason) {
        finish();
        controller.abort(reason);
        stopReading(reason);
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    cleanup();
    throw error;
  }
}
