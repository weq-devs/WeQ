let pending = false;

export function remoteWorkspaceCheckPending() {
  return pending;
}

export function setRemoteWorkspaceCheckPending(value: boolean) {
  pending = value;
}
