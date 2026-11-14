import type { EnhancementEngineKind } from '../../shared/enhancement_manifest';
import { AsyncLocalStorage } from 'node:async_hooks';

let activeStore: { directory(kind: EnhancementEngineKind): string | null } | null = null;
const leases = new Map<EnhancementEngineKind, number>();
const switching = new Map<EnhancementEngineKind, Promise<void>>();
export function blockEnhancementEngineUse(kinds: EnhancementEngineKind[]): () => void {
  const releases: Array<() => void> = [];
  for (const kind of kinds) {
    const pending = new Promise<void>((resolve) =>
      releases.push(() => {
        switching.delete(kind);
        resolve();
      }),
    );
    switching.set(kind, pending);
  }
  return () => {
    for (const release of releases) release();
  };
}
const candidateDirectories = new AsyncLocalStorage<
  Partial<Record<EnhancementEngineKind, string>>
>();
export function withEnhancementEngineDirectories<T>(
  directories: Partial<Record<EnhancementEngineKind, string>>,
  action: () => T,
): T {
  return candidateDirectories.run(directories, action);
}

export function setEnhancementEngineStore(store: typeof activeStore) {
  activeStore = store;
}
export function enhancementEngineBusy(kind: EnhancementEngineKind) {
  return (leases.get(kind) ?? 0) > 0;
}
export function enhancementEngineEnvironment(kind: EnhancementEngineKind): NodeJS.ProcessEnv {
  return {
    ...process.env,
    WEQ_ENHANCEMENT_RUNTIME:
      candidateDirectories.getStore()?.[kind] ?? activeStore?.directory(kind) ?? '',
    ELECTRON_RUN_AS_NODE: '1',
  };
}
export function enhancementEngineAvailable(kind: EnhancementEngineKind): boolean {
  return (
    !!candidateDirectories.getStore()?.[kind] ||
    (activeStore ? !!activeStore.directory(kind) : true)
  );
}
export async function withEnhancementEngine<T>(
  kind: EnhancementEngineKind,
  action: () => Promise<T>,
): Promise<T> {
  while (switching.has(kind)) await switching.get(kind);
  leases.set(kind, (leases.get(kind) ?? 0) + 1);
  try {
    return await action();
  } finally {
    leases.set(kind, (leases.get(kind) ?? 1) - 1);
  }
}
