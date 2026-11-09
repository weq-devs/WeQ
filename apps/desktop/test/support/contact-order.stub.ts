const rows = {},
  regions: never[] = [],
  options = {};
const friendPreferences = { grouping: 'qq', sort: 'remark', descending: false };
const groupPreferences = { grouping: 'notify', sort: 'remark', descending: false };
export function useContactDirectoryOrder(kind: string) {
  return {
    preferences: kind === 'friends' ? friendPreferences : groupPreferences,
    rows,
    regions,
    groupingOptions: options,
    sortOptions: options,
    change: () => {},
  };
}
export const useFrozenDirectory = <T>(value: T) => value;
