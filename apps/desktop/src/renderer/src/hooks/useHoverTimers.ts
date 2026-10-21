import { useCallback, useEffect, useRef } from 'react';

/** 展开与收起分别计时，重复移出不能延长连续离开的期限。 */
export function useHoverTimers(onOpen: () => void, onClose: () => void) {
  const openRef = useRef(onOpen);
  const closeRef = useRef(onClose);
  openRef.current = onOpen;
  closeRef.current = onClose;
  const opening = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelOpen = useCallback(() => {
    if (opening.current !== null) clearTimeout(opening.current);
    opening.current = null;
  }, []);
  const cancelClose = useCallback(() => {
    if (closing.current !== null) clearTimeout(closing.current);
    closing.current = null;
  }, []);
  const cancel = useCallback(() => {
    cancelOpen();
    cancelClose();
  }, [cancelOpen, cancelClose]);
  const startOpen = useCallback(() => {
    cancel();
    opening.current = setTimeout(() => {
      opening.current = null;
      openRef.current();
    }, 500);
  }, [cancel]);
  const startClose = useCallback(() => {
    cancelOpen();
    if (closing.current !== null) return;
    closing.current = setTimeout(() => {
      closing.current = null;
      closeRef.current();
    }, 1000);
  }, [cancelOpen]);
  useEffect(() => cancel, [cancel]);
  return { startOpen, cancelOpen, startClose, cancelClose, cancel };
}
