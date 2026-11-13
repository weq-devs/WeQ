import { useRef } from 'react';

/** 仅在本次编辑和同一目标内恢复精确选择，不持久化到其他账号。 */
export function useExactSelectionMode(
  scope: string,
  selected: readonly string[] | undefined,
  onChange: (ids: string[] | undefined) => void,
) {
  const memory = useRef<{ scope: string; ids: string[] }>({ scope, ids: [] });
  if (memory.current.scope !== scope) memory.current = { scope, ids: [] };
  if (selected !== undefined) memory.current.ids = [...selected];
  return (mode: 'condition' | 'exact') =>
    onChange(mode === 'exact' ? [...memory.current.ids] : undefined);
}
