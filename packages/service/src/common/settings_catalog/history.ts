export const HISTORY_CAPACITIES_MIB = [0, 64, 128, 256, 512, 1024] as const;
export type HistoryCapacityMiB = (typeof HISTORY_CAPACITIES_MIB)[number];

export function isHistoryCapacityMiB(value: unknown): value is HistoryCapacityMiB {
  return HISTORY_CAPACITIES_MIB.some((capacity) => capacity === value);
}

export function historyCapacityLabel(capacity: HistoryCapacityMiB): string {
  if (capacity === 0) return '不限容量';
  if (capacity === 1024) return '1 GiB';
  return `${capacity} MiB`;
}

export const HISTORY_CAPACITY_OPTIONS = HISTORY_CAPACITIES_MIB.map((capacity) => ({
  value: String(capacity),
  label: historyCapacityLabel(capacity),
}));
