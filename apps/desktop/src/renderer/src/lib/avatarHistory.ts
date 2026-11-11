import type { HistoricalAvatar } from '@weq/protocol';

export function sortHistoricalAvatars(
  items: HistoricalAvatar[],
  field: 'firstUsedAt' | 'lastUsedAt',
  ascending: boolean,
) {
  return [...items].sort((a, b) => {
    const x = a[field],
      y = b[field];
    if (x === null || y === null) return x === y ? a.id.localeCompare(b.id) : x === null ? 1 : -1;
    return (ascending ? x - y : y - x) || a.id.localeCompare(b.id);
  });
}
