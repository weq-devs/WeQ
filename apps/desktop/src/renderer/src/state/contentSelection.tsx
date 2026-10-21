import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import {
  reduceContentSelection,
  type ContentOwner,
  type ContentSelection,
  copyContentScope,
} from '../../../shared/content_selection';
import type { AnalysisTarget, AnalysisToolRequest } from '../views/analysis/model';
import type { Message } from '../im-template/template/types';
import { useTabActive } from '../components/RetainedTabs';

type Registry = Record<string, ContentSelection | undefined>;
interface SelectionMemory {
  anchorRef: { current: string | null };
  messageCache: Map<string, Message>;
  selectedIdsRef: { current: ReadonlySet<string> };
  users: number;
}
const ownerKey = (owner: ContentOwner) => JSON.stringify([owner.kind, owner.container]);
const newMemory = (): SelectionMemory => ({
  anchorRef: { current: null },
  messageCache: new Map(),
  selectedIdsRef: { current: new Set() },
  users: 0,
});

interface SelectionContextValue {
  selection: ContentSelection | null;
  registry: Registry;
  update(owner: ContentOwner, action: SetStateAction<ContentSelection | null>): void;
  activate(owner: ContentOwner): void;
  memory(owner: ContentOwner): SelectionMemory;
  retain(owner: ContentOwner, memory: SelectionMemory): () => void;
  reset(): void;
  exportRequest: { selection: ContentSelection; revision: number } | null;
  requestExport: (selection: ContentSelection) => void;
  analysisRequest: AnalysisToolRequest | null;
  requestAnalysis: (target: AnalysisTarget, messageIds: string[]) => void;
}

const SelectionContext = createContext<SelectionContextValue | null>(null);

/** 随账号工作区挂载和销毁，不写全局单例或持久存储，避免静态/在线同号串选择。 */
export function ContentSelectionProvider({ children }: { children: ReactNode }) {
  const [registry, setRegistry] = useState<Registry>({});
  const [activeKey, setActiveKey] = useState('');
  const memories = useRef(new Map<string, SelectionMemory>());
  const registryRef = useRef(registry);
  registryRef.current = registry;
  const activate = useCallback((owner: ContentOwner) => {
    const key = ownerKey(owner);
    const registry = registryRef.current;
    setActiveKey((previous) => {
      if (registry[key]) return key;
      const current = registry[previous];
      // 消息与会话侧栏同屏；空的聊天面板不能盖掉侧栏已有的多选。
      if (owner.kind === 'messages') {
        const sidebar = ownerKey({ kind: 'conversations', container: 'main-list' });
        if (registry[sidebar]) return sidebar;
      }
      if (owner.kind === 'conversations' && current?.owner.kind === 'messages') return previous;
      return key;
    });
  }, []);
  const memory = useCallback((owner: ContentOwner) => {
    const key = ownerKey(owner);
    if (!memories.current.has(key)) memories.current.set(key, newMemory());
    return memories.current.get(key)!;
  }, []);
  const retain = useCallback((owner: ContentOwner, entry: SelectionMemory) => {
    const key = ownerKey(owner);
    if (!memories.current.has(key)) memories.current.set(key, entry);
    entry.users++;
    return () => {
      entry.users--;
      if (!entry.users && !registryRef.current[key] && memories.current.get(key) === entry)
        memories.current.delete(key);
    };
  }, []);
  const update = useCallback(
    (owner: ContentOwner, action: SetStateAction<ContentSelection | null>) => {
      const key = ownerKey(owner);
      setActiveKey(key);
      setRegistry((previous) => {
        const before = previous[key] ?? null;
        const next = typeof action === 'function' ? action(before) : action;
        if (before === next) return previous;
        const registry = { ...previous };
        if (next) registry[key] = next;
        else delete registry[key];
        return registry;
      });
    },
    [],
  );
  const selection = registry[activeKey] ?? null;
  const [exportRequest, setExportRequest] = useState<SelectionContextValue['exportRequest']>(null);
  const [analysisRequest, setAnalysisRequest] = useState<AnalysisToolRequest | null>(null);
  const reset = useCallback(() => {
    setRegistry({});
    memories.current.clear();
    setActiveKey('');
    setExportRequest(null);
    setAnalysisRequest(null);
  }, []);
  const requestAnalysis = useCallback((target: AnalysisTarget, messageIds: string[]) => {
    setAnalysisRequest((previous) => ({
      target: { ...target },
      messageIds: [...messageIds],
      revision: (previous?.revision ?? 0) + 1,
    }));
  }, []);
  const requestExport = useCallback(
    (next: ContentSelection) =>
      setExportRequest((previous) => ({
        selection: { owner: { ...next.owner }, scope: copyContentScope(next.scope) },
        revision: (previous?.revision ?? 0) + 1,
      })),
    [],
  );
  const value = useMemo(
    () => ({
      selection,
      registry,
      update,
      activate,
      memory,
      retain,
      reset,
      exportRequest,
      requestExport,
      analysisRequest,
      requestAnalysis,
    }),
    [
      selection,
      registry,
      update,
      activate,
      memory,
      retain,
      reset,
      exportRequest,
      requestExport,
      analysisRequest,
      requestAnalysis,
    ],
  );
  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

export function useContentAnalysisRequest() {
  return useContext(SelectionContext)?.analysisRequest ?? null;
}

export function useRequestContentAnalysis() {
  return useContext(SelectionContext)?.requestAnalysis ?? null;
}

export function useContentExportRequest() {
  return useContext(SelectionContext)?.exportRequest ?? null;
}

export function useRequestContentExport() {
  return useContext(SelectionContext)?.requestExport ?? null;
}

export function useCurrentContentSelection(): ContentSelection | null {
  return useContext(SelectionContext)?.selection ?? null;
}

/** 同号切配置仍清空旧来源；同一来源内的页面／会话切换保留各自选区。 */
export function useContentSelectionScope(source: string) {
  const context = useContext(SelectionContext);
  const previous = useRef(source);
  useLayoutEffect(() => {
    if (previous.current && previous.current !== source) context?.reset();
    previous.current = source;
  }, [source, context?.reset]);
}

export function useContentMultiSelect(owner: ContentOwner, activePage = true) {
  const context = useContext(SelectionContext);
  const [local, setLocal] = useState<Registry>({});
  const localMemories = useRef(new Map<string, SelectionMemory>());
  const localRef = useRef(local);
  localRef.current = local;
  const tabActive = useTabActive();
  const { kind, container } = owner;
  const key = ownerKey(owner);
  const selection = (context ? context.registry : local)[key] ?? null;
  const update = useCallback(
    (action: SetStateAction<ContentSelection | null>) => {
      if (context?.update) {
        context.update({ kind, container }, action);
        return;
      }
      setLocal((previous) => {
        const before = previous[key] ?? null;
        const next = typeof action === 'function' ? action(before) : action;
        if (before === next) return previous;
        const registry = { ...previous };
        if (next) registry[key] = next;
        else delete registry[key];
        return registry;
      });
    },
    [context?.update, kind, container, key],
  );
  if (!context && !localMemories.current.has(key)) localMemories.current.set(key, newMemory());
  const memory = context ? context.memory(owner) : localMemories.current.get(key)!;
  useEffect(() => {
    if (context?.retain) return context.retain({ kind, container }, memory);
    if (!localMemories.current.has(key)) localMemories.current.set(key, memory);
    return () => {
      if (!localRef.current[key]) localMemories.current.delete(key);
    };
  }, [context?.retain, kind, container, key, memory]);
  useEffect(() => {
    if (tabActive && activePage) context?.activate({ kind, container });
  }, [context?.activate, kind, container, tabActive, activePage]);
  const active = Boolean(selection);
  const selectedIds = useMemo(
    () => new Set(active && selection?.scope.type === 'items' ? selection.scope.ids : []),
    [active, selection],
  );
  memory.selectedIdsRef.current = selectedIds;
  const setSelectedIds = useCallback<Dispatch<SetStateAction<Set<string>>>>(
    (value) => {
      update((previous) => {
        const current = previous?.scope.type === 'items' ? previous.scope.ids : [];
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
      if (!enabled) {
        memory.anchorRef.current = null;
        memory.messageCache.clear();
      }
      update((previous) => {
        if (!enabled)
          return reduceContentSelection(previous, { type: 'clear', owner: { kind, container } });
        if (previous) return previous;
        return reduceContentSelection(previous, {
          type: 'select',
          owner: { kind, container },
          ids: [],
        });
      });
    },
    [update, kind, container, memory],
  );
  const removeSelectedIds = useCallback(
    (ids: readonly string[]) => {
      const removed = new Set(ids);
      update((previous) => {
        if (previous?.scope.type !== 'items') return previous;
        const remaining = previous.scope.ids.filter((id) => !removed.has(id));
        return remaining.length === previous.scope.ids.length
          ? previous
          : reduceContentSelection(previous, {
              type: 'select',
              owner: { kind, container },
              ids: remaining,
            });
      });
    },
    [update, kind, container],
  );
  return {
    selectionMode: active,
    selectedIds,
    setSelectedIds,
    setSelectionMode,
    removeSelectedIds,
    anchorRef: memory.anchorRef,
    messageCache: memory.messageCache,
    selectedIdsRef: memory.selectedIdsRef,
  };
}
