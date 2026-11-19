import { useCallback, useMemo, useState, useRef, type ReactNode, type SetStateAction } from 'react';
import {
  type ContentOwner,
  type ContentSelection,
  copyContentScope,
} from '../../../shared/content_selection';
import type { AnalysisTarget, AnalysisToolRequest } from '../views/analysis/model';
import {
  type Registry,
  type SelectionMemory,
  ownerKey,
  newMemory,
  type SelectionContextValue,
  SelectionContext,
} from './contentSelection.shared';

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
        selection: {
          owner: {
            ...next.owner,
            ...(next.owner.forwardTarget
              ? { forwardTarget: structuredClone(next.owner.forwardTarget) }
              : {}),
          },
          scope: copyContentScope(next.scope),
        },
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
