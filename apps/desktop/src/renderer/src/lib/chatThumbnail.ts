import { IS_ELECTRON } from './target.shared';

export async function fetchChatThumbnail(
  src: string,
  signal: AbortSignal,
): Promise<Blob | 'deferred' | null> {
  signal.throwIfAborted();
  const ipc =
    IS_ELECTRON &&
    src.startsWith('weq-media://pic?') &&
    new URL(src).searchParams.get('recv') !== '1'
      ? window.electron?.ipcRenderer
      : undefined;
  if (ipc) {
    const id = crypto.randomUUID();
    const cancel = () => ipc.send('media:cancel-thumbnail', id);
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const reply: { bytes: ArrayBuffer; type: string | null } | 'deferred' | null =
        await ipc.invoke('media:thumbnail', id, src);
      if (signal.aborted) return null;
      return reply && reply !== 'deferred'
        ? new Blob([reply.bytes], { type: reply.type ?? '' })
        : reply;
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }
  const response = await fetch(src, { signal });
  if (response.ok) return response.blob();
  await response.body?.cancel();
  return response.headers.get('X-WeQ-Media-State') === 'deferred' ? 'deferred' : null;
}
