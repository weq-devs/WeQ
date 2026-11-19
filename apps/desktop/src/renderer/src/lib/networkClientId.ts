export const networkClientId = (() => {
  try {
    const saved = localStorage.getItem('weq.network-client-id');
    if (saved && /^[\w-]{1,80}$/.test(saved)) return saved;
    const id = globalThis.crypto.randomUUID();
    localStorage.setItem('weq.network-client-id', id);
    return id;
  } catch {
    return globalThis.crypto.randomUUID();
  }
})();
