import { useEffect, useRef, useState } from 'react';
import type { EnhancementUpdateNotice } from '../../../shared/enhancement_release';
import { client } from '../trpc/client';
import { useDialog } from '../components/Dialog.shared';
import { requestOpenSettings } from '../lib/callSettingsBridge';

function updateMessage(notices: EnhancementUpdateNotice[]) {
  return (
    <>
      <p>以下增强包可更新：</p>
      <ul>
        {notices.map((notice) => (
          <li key={notice.id}>{notice.name}</li>
        ))}
      </ul>
    </>
  );
}

/** 一次检查的增强包共用一张提醒；其他确认框关闭后再显示，不抢占用户操作。 */
export function useEnhancementUpdates() {
  const [notices, setNotices] = useState<EnhancementUpdateNotice[]>([]);
  const currentDialog = useDialog((state) => state.current);
  const shown = useRef(new Map<string, string>());
  const active = useRef<{ id: number; notices: EnhancementUpdateNotice[] } | null>(null);
  useEffect(() => {
    const subscription = client.bootstrap.onEnhancementUpdates.subscribe(undefined, {
      onData: setNotices,
      onError: (error) => console.error('[enhancements] notification subscription error', error),
    });
    return () => subscription.unsubscribe();
  }, []);
  useEffect(() => {
    if (currentDialog && currentDialog.id !== active.current?.id) return;
    const updates = notices.filter(
      (notice) => shown.current.get(notice.id) !== notice.contentVersion,
    );
    if (!updates.length) return;
    for (const notice of updates) shown.current.set(notice.id, notice.contentVersion);
    if (currentDialog && active.current) {
      const merged = new Map(
        [...active.current.notices, ...updates].map((notice) => [notice.id, notice]),
      );
      active.current.notices = [...merged.values()];
      useDialog.setState({
        current: { ...currentDialog, message: updateMessage(active.current.notices) },
      });
    } else {
      const confirmed = useDialog.getState().confirm('增强包有可用更新', updateMessage(updates), {
        tone: 'info',
        okLabel: '前往增强包',
        cancelLabel: '稍后',
      });
      active.current = { id: useDialog.getState().current!.id, notices: updates };
      void confirmed.then((open) => {
        if (open) requestOpenSettings('enhancementPacks');
      });
    }
    void client.bootstrap.acknowledgeEnhancementUpdates
      .mutate(updates.map(({ id, contentVersion }) => ({ id, contentVersion })))
      .catch((error) => console.error('[enhancements] notification acknowledgement failed', error));
  }, [notices, currentDialog]);
}
