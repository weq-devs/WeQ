export const RESTORE_SEARCH_EVENT = 'weq:restore-global-search';

export function restoreGlobalSearch(): void {
  window.dispatchEvent(new Event(RESTORE_SEARCH_EVENT));
}

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
