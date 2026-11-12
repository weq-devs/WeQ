import { useEffect, useRef, type RefObject } from 'react';
import '../styles/search-target.css';

export function useSearchTargetFocus(
  root: RefObject<HTMLElement | null>,
  attribute: string,
  id: string | undefined,
  ready = true,
  revision?: number,
) {
  const focused = useRef('');
  useEffect(() => {
    if (!ready || !id || focused.current === `${attribute}:${id}`) return;
    const target = [...(root.current?.querySelectorAll<HTMLElement>(`[${attribute}]`) ?? [])].find(
      (item) => item.getAttribute(attribute) === id,
    );
    if (!target) return;
    focused.current = `${attribute}:${id}`;
    target.scrollIntoView?.({ block: 'nearest' });
    target.classList.add('weq-search-target');
  }, [root, attribute, id, ready, revision]);
}
