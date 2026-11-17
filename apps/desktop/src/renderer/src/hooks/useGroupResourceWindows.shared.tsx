import { useCallback, useEffect, useRef, useState } from 'react';
import {
  groupResourceWindowName,
  readGroupResourceWindowName,
  type GroupResourceKind,
} from '../../../shared/group_resource_window';
import { focusToolPopup, openToolPopup } from './useCompositionWindow';
import { useAppLock } from '../state/lock';
import '../styles/group-resource-window.css';
import { GroupResourceWindow } from './useGroupResourceWindows';

export interface GroupResourceRequest {
  kind: GroupResourceKind;
  groupCode: string;
  groupName: string;
  initialAlbumId?: string;
  initialFolderId?: string;
  initialFileId?: string;
  onJumpToMessage?: (sequence: string, messageId: string) => void;
}

export interface Entry {
  ownerKey: string;
  key: string;
  request: GroupResourceRequest;
  popup: Window | null;
  instance: number;
}

/** 群资源窗固定绑定打开时的群；会话切换不销毁，账号或数据源变更才释放。 */
export function useGroupResourceWindows({ ownerKey }: { ownerKey: string }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const registry = useRef(new Map<string, Entry>());
  const sequence = useRef(0);
  const close = useCallback((key: string, instance?: number) => {
    const entry = registry.current.get(key);
    if (!entry || (instance !== undefined && instance !== entry.instance)) return;
    registry.current.delete(key);
    if (entry.popup && !entry.popup.closed) entry.popup.close();
    setEntries((current) => current.filter((item) => item.key !== key));
  }, []);
  useEffect(() => {
    for (const [key, entry] of registry.current) if (entry.ownerKey !== ownerKey) close(key);
  }, [ownerKey, close]);
  const open = useCallback(
    (request: GroupResourceRequest) => {
      if (!ownerKey || useAppLock.getState().locked) return false;
      const key = groupResourceWindowName(ownerKey, request.groupCode, request.kind);
      if (!readGroupResourceWindowName(key)) return false;
      const existing = registry.current.get(key);
      if (existing && !existing.popup?.closed) {
        focusToolPopup(key, existing.popup);
        return true;
      }
      const entry: Entry = {
        ownerKey,
        key,
        request: { ...request },
        popup: openToolPopup(key, 1060, 780),
        instance: ++sequence.current,
      };
      registry.current.set(key, entry);
      setEntries((current) => [...current.filter((item) => item.key !== key), entry]);
      return true;
    },
    [ownerKey],
  );
  return {
    open,
    windows: entries
      .filter((entry) => entry.ownerKey === ownerKey)
      .map((entry) => (
        <GroupResourceWindow
          key={`${entry.key}:${entry.instance}`}
          entry={entry}
          onClose={() => close(entry.key, entry.instance)}
        />
      )),
  };
}
