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

/** 反选当前结果，不改变筛选外的选择。 */
export function invertSelectionIds<K>(ids: readonly K[], selected: ReadonlySet<K>): Set<K> {
  const next = new Set(selected);
  for (const id of new Set(ids)) {
    if (next.has(id)) next.delete(id);
    else next.add(id);
  }
  return next;
}
