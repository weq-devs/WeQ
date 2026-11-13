import type { EnhancementEngineKind } from '../../shared/enhancement_manifest';

let activeStore: { directory(kind: EnhancementEngineKind): string | null } | null = null;
const leases = new Map<EnhancementEngineKind, number>();

export function setEnhancementEngineStore(store: typeof activeStore) {
  activeStore = store;
}
export function enhancementEngineBusy(kind: EnhancementEngineKind) {
  return (leases.get(kind) ?? 0) > 0;
}
export function enhancementEngineEnvironment(kind: EnhancementEngineKind): NodeJS.ProcessEnv {
  return {
    ...process.env,
    WEQ_ENHANCEMENT_RUNTIME: activeStore?.directory(kind) ?? '',
    ELECTRON_RUN_AS_NODE: '1',
  };
}
export function enhancementEngineAvailable(kind: EnhancementEngineKind): boolean {
  return activeStore ? !!activeStore.directory(kind) : true;
}
export async function withEnhancementEngine<T>(
  kind: EnhancementEngineKind,
  action: () => Promise<T>,
): Promise<T> {
  leases.set(kind, (leases.get(kind) ?? 0) + 1);
  try {
    return await action();
  } finally {
    leases.set(kind, (leases.get(kind) ?? 1) - 1);
  }
}
