let pending = false;
const listeners = new Set<() => void>();

export function remoteWorkspaceCheckPending() {
  return pending;
}

export function setRemoteWorkspaceCheckPending(value: boolean) {
  if (value === pending) return;
  pending = value;
  for (const listener of listeners) listener();
}

export function subscribeRemoteWorkspaceCheck(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
