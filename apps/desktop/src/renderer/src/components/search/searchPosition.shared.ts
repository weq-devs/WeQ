export interface SearchPosition {
  scrollTop: number;
  focusKey: string | null;
  appResultsExpanded?: boolean;
}

export function restoreSearchPosition(node: HTMLElement, position: SearchPosition): void {
  const hit = [...node.querySelectorAll<HTMLElement>('[data-search-hit-key]')].find(
    (item) => item.dataset.searchHitKey === position.focusKey,
  );
  hit?.focus({ preventScroll: true });
  node.scrollTop = position.scrollTop;
}
