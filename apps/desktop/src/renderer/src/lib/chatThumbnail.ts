export async function fetchChatThumbnail(src: string, signal: AbortSignal): Promise<Blob | null> {
  signal.throwIfAborted();
  const ipc = src.startsWith('weq-media://pic?') ? window.electron?.ipcRenderer : undefined;
  if (ipc) {
    const id = crypto.randomUUID();
    const cancel = () => ipc.send('media:cancel-thumbnail', id);
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const reply: { bytes: ArrayBuffer; type: string | null } | null = await ipc.invoke(
        'media:thumbnail',
        id,
        src,
      );
      return reply && !signal.aborted ? new Blob([reply.bytes], { type: reply.type ?? '' }) : null;
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }
  const response = await fetch(src, { signal });
  if (response.ok) return response.blob();
  await response.body?.cancel();
  return null;
}
