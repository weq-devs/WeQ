const capacityPresetsMiB = [64, 128, 256, 512, 1024];

export const DEFAULT_HISTORY_CAPACITY_MIB = 256;
export const MAX_HISTORY_CAPACITY_MIB = Math.floor(Number.MAX_SAFE_INTEGER / 1024 ** 2);
export type HistoryCapacityMiB = number;

export function isHistoryCapacityMiB(value: unknown): value is HistoryCapacityMiB {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_HISTORY_CAPACITY_MIB
  );
}

export function historyCapacityLabel(capacity: HistoryCapacityMiB): string {
  if (capacity === 0) return '不限容量';
  if (capacity === 1024) return '1 GiB';
  return `${capacity} MiB`;
}

export const HISTORY_CAPACITY_OPTIONS = capacityPresetsMiB.map((capacity) => ({
  value: String(capacity),
  label: historyCapacityLabel(capacity),
}));
