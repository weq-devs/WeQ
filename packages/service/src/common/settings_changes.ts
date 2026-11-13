const listeners = new Set<() => void>();
export function onSettingsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function emitSettingsChanged(): void {
  for (const listener of listeners) listener();
}
