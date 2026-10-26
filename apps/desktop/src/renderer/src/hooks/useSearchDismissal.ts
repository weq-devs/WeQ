import { useEffect } from 'react';

export function useSearchDismissal(
  query: string,
  focused: boolean,
  setDismissed: (dismissed: boolean) => void,
  setFocused: (focused: boolean) => void,
) {
  useEffect(() => {
    if (!query && !focused) return;
    function onKey(event: KeyboardEvent): void {
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        document.activeElement?.closest(
          '.weq-titlebar-search, .weq-search-dropdown, .weq-search-history',
        )
      ) {
        setDismissed(true);
        setFocused(false);
      }
    }
    function onMouseDown(event: MouseEvent): void {
      const target = event.target;
      if (target instanceof Element) {
        if (target.closest('.search-box, .weq-titlebar-search')) {
          setDismissed(false);
          setFocused(true);
          return;
        }
        if (target.closest('.weq-search-dropdown')) return;
      }
      setDismissed(true);
      setFocused(false);
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [query, focused, setDismissed, setFocused]);
}
