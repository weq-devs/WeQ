import { useEffect, useRef } from 'react';
import { usePageDraftConfirmation, usePageState } from '../PageSnapshots';
import { pageValue } from '../../lib/pageSnapshots';

/** 数字的显示草稿可保留前导零；与服务端数值相等时不再视为未保存。 */
export function useNumericSettingDraft(name: string, saved: number | undefined, fallback = 0) {
  const [draft, setDraft] = usePageState(
    name,
    () => String(saved ?? fallback),
    pageValue.string,
    true,
  );
  const previous = useRef(saved ?? fallback);
  useEffect(() => {
    if (saved === undefined) return;
    const before = previous.current;
    setDraft((current) => (current === String(before) ? String(saved) : current));
    previous.current = saved;
  }, [saved, fallback, setDraft]);
  usePageDraftConfirmation(
    name,
    saved === undefined
      ? undefined
      : draft.trim() && Number(draft) === saved
        ? draft
        : String(saved),
  );
  return [draft, setDraft] as const;
}
