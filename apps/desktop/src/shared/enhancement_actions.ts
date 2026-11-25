export type EnhancementBatchAction = 'download' | 'update';

export function canPrepareEnhancement(
  pack: {
    busy: boolean;
    blocker: string | null;
    installed: boolean;
    downloaded: boolean;
    needsRepair: boolean;
    updateAvailable: boolean;
  },
  action: EnhancementBatchAction,
  waiting: boolean,
) {
  if (pack.busy || pack.blocker || waiting) return false;
  return action === 'download'
    ? !pack.installed && !pack.downloaded
    : pack.installed && pack.updateAvailable && !pack.needsRepair;
}
