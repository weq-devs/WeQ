import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import {
  reduceContentSelection,
  sameContentOwner,
  type ContentOwner,
  type ContentSelection,
} from '../../../shared/content_selection';

interface SelectionContextValue {
  selection: ContentSelection | null;
  setSelection: Dispatch<SetStateAction<ContentSelection | null>>;
}

const SelectionContext = createContext<SelectionContextValue | null>(null);

/** 随账号工作区挂载和销毁，不写全局单例或持久存储，避免静态/在线同号串选择。 */
export function ContentSelectionProvider({ children }: { children: ReactNode }) {
  const [selection, setSelection] = useState<ContentSelection | null>(null);
  const value = useMemo(() => ({ selection, setSelection }), [selection]);
  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

export function useCurrentContentSelection(): ContentSelection | null {
  return useContext(SelectionContext)?.selection ?? null;
}

export function useContentMultiSelect(owner: ContentOwner) {
  const context = useContext(SelectionContext);
  // 模板演示等独立挂载仍可使用本地多选；真实账号界面由同一个 provider 统一管理。
  const [local, setLocal] = useState<ContentSelection | null>(null);
  const selection = context ? context.selection : local;
  const update = context ? context.setSelection : setLocal;
  const { kind, container } = owner;
  const active = Boolean(selection && sameContentOwner(selection.owner, owner));
  const selectedIds = useMemo(
    () => new Set(active && selection?.scope.type === 'items' ? selection.scope.ids : []),
    [active, selection],
  );
  const setSelectedIds = useCallback<Dispatch<SetStateAction<Set<string>>>>(
    (value) => {
      update((previous) => {
        const current =
          previous &&
          sameContentOwner(previous.owner, { kind, container }) &&
          previous.scope.type === 'items'
            ? previous.scope.ids
            : [];
        const ids = typeof value === 'function' ? value(new Set(current)) : value;
        return reduceContentSelection(previous, {
          type: 'select',
          owner: { kind, container },
          ids: [...ids],
        });
      });
    },
    [update, kind, container],
  );
  const setSelectionMode = useCallback(
    (enabled: boolean) => {
      update((previous) => {
        if (!enabled)
          return reduceContentSelection(previous, { type: 'clear', owner: { kind, container } });
        if (previous && sameContentOwner(previous.owner, { kind, container })) return previous;
        return reduceContentSelection(previous, {
          type: 'select',
          owner: { kind, container },
          ids: [],
        });
      });
    },
    [update, kind, container],
  );
  return { selectionMode: active, selectedIds, setSelectedIds, setSelectionMode };
}
