import { createContext, useCallback, useContext, useEffect, useRef } from 'react';
import { useDialog } from '../components/Dialog';

type DraftState = { dirty: boolean; busy: boolean };
type Drafts = Set<() => DraftState>;
export const DraftCloseContext = createContext<Drafts | null>(null);

/** 基线只在打开或保存成功后更新，不将草稿或凭据写到持久存储。 */
function useDraftSnapshot(value: unknown, busy: boolean) {
  const snapshot = JSON.stringify(value);
  const baseline = useRef(snapshot);
  const current = useRef({ snapshot, busy });
  current.current = { snapshot, busy };
  const read = useRef(() => ({
    dirty: current.current.snapshot !== baseline.current,
    busy: current.current.busy,
  }));
  const markSaved = useCallback(() => {
    baseline.current = current.current.snapshot;
  }, []);
  const reset = useCallback((next: unknown) => {
    baseline.current = JSON.stringify(next);
  }, []);
  return {
    read: read.current,
    markSaved,
    reset,
  };
}

/** 子设置页向所属弹窗报告草稿状态，隐藏页仍保留，卸载时撤销注册。 */
export function useDraftProtection(value: unknown, busy = false) {
  const drafts = useContext(DraftCloseContext);
  const draft = useDraftSnapshot(value, busy);
  useEffect(() => {
    drafts?.add(draft.read);
    return () => {
      drafts?.delete(draft.read);
    };
  }, [drafts, draft.read]);
  return draft;
}

export function useDraftClose(onClose: () => void, value: unknown, busy = false) {
  const draft = useDraftSnapshot(value, busy);
  const drafts = useRef<Drafts>(new Set());
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const states = () => [draft.read(), ...[...drafts.current].map((read) => read())];
  const confirmLeave = async (action: () => void) => {
    if (pending.current || states().some((state) => state.busy)) return;
    if (!states().some((state) => state.dirty)) {
      action();
      return;
    }
    pending.current = true;
    try {
      const discard = await useDialog
        .getState()
        .confirm('放弃未保存的修改？', '关闭后，本次尚未保存的内容将丢失。', {
          okLabel: '放弃修改',
          cancelLabel: '继续编辑',
          tone: 'warning',
        });
      if (discard && mounted.current && !states().some((state) => state.busy)) action();
    } finally {
      pending.current = false;
    }
  };
  return {
    ...draft,
    drafts: drafts.current,
    confirmLeave,
    requestClose: () => {
      void confirmLeave(onClose);
    },
  };
}
