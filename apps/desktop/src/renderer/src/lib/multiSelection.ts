export function allSelectionIdsSelected<K>(ids: readonly K[], selected: ReadonlySet<K>): boolean {
  return ids.length > 0 && ids.every((id) => selected.has(id));
}

/** 全选和取消全选只作用于当前结果，保留筛选外的选择。 */
export function toggleAllSelectionIds<K>(ids: readonly K[], selected: ReadonlySet<K>): Set<K> {
  const next = new Set(selected);
  const allSelected = allSelectionIdsSelected(ids, selected);
  for (const id of ids) {
    if (allSelected) next.delete(id);
    else next.add(id);
  }
  return next;
}
