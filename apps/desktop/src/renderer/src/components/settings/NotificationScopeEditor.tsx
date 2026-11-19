import { useEffect, useMemo, useRef, useState } from 'react';
import { Save, SlidersHorizontal } from 'lucide-react';
import { classifyChatType } from '@weq/codec';
import {
  normalizeNotificationScope,
  NOTIFICATION_LABELS,
  type ScopedNotificationEvent,
} from '@weq/service/notification-settings';
import { trpc } from '../../trpc/client';
import {
  accountBinding,
  isAccountStateReady,
  patchAccountRecords,
  sharedAccountRecords,
  useClientPreferences,
} from '../../lib/clientPreferences';
import { ConversationPicker } from '../../views/export/ConversationPicker';
import { convAvatarUrl } from '../../views/export/types';
import { ToolSurface } from '../ToolSurface';
import { PageShell } from '../PageShell';
import { SegmentedControl } from '../SegmentedControl';
import { useViewState } from '../../state/view';
import { useAppLock } from '../../state/lock';
import { useTabActive } from '../RetainedTabs.shared';
import '../../styles/notification-scope-editor.css';

export function NotificationScopeEditor({ event }: { event: ScopedNotificationEvent }) {
  useClientPreferences((state) => state.tick);
  const hasAccount = Boolean(useViewState((state) => state.openedUin));
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'all' | 'selected'>('selected');
  const [selected, setSelected] = useState(new Set<string>());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const source = useRef(accountBinding());
  const active = useTabActive();
  const locked = useAppLock((state) => state.locked);
  const sourceKey = JSON.stringify(accountBinding());
  useEffect(() => {
    if (!active || locked || sourceKey !== JSON.stringify(source.current)) setOpen(false);
  }, [active, locked, sourceKey]);
  const saved = normalizeNotificationScope(event, sharedAccountRecords('notifications')[event]);
  const query = trpc.account.listConversationsWithCount.useQuery(undefined, {
    enabled: open && hasAccount && active && !locked,
    refetchOnWindowFocus: false,
  });
  const items = useMemo(
    () =>
      (query.data ?? []).flatMap((row) => {
        const type = classifyChatType(row.chatType);
        if (type !== 'direct' && type !== 'group') return [];
        const kind = type === 'group' ? ('group' as const) : ('c2c' as const);
        return [
          {
            id: `${kind}:${row.targetUid}`,
            name: row.targetDisplayName || row.targetUid,
            kind,
            uin: row.targetUin,
            avatarUrl: convAvatarUrl(kind, row.targetUid, row.targetUin),
          },
        ];
      }),
    [query.data],
  );
  return (
    <>
      <button
        type="button"
        className="weq-set-iconbtn"
        title="选择提醒会话"
        aria-label={`${NOTIFICATION_LABELS[event]}：选择提醒会话`}
        disabled={!hasAccount || !isAccountStateReady()}
        onClick={() => {
          source.current = accountBinding();
          setMode(saved.mode);
          setSelected(new Set(saved.targets));
          setError('');
          setOpen(true);
        }}
      >
        <SlidersHorizontal size={14} aria-hidden />
      </button>
      {open && (
        <ToolSurface
          title={`${NOTIFICATION_LABELS[event]} · 提醒会话`}
          presentation="modal"
          draft={
            mode !== saved.mode ||
            JSON.stringify([...selected].sort()) !== JSON.stringify([...saved.targets].sort())
              ? [mode, [...selected].sort()]
              : null
          }
          busy={saving}
          onClose={() => setOpen(false)}
        >
          {(requestClose) => (
            <div className="weq-notification-scope-editor">
              <PageShell
                title={`${NOTIFICATION_LABELS[event]} · 提醒会话`}
                onClose={requestClose}
                actions={
                  <button
                    type="button"
                    className="weq-set-btn weq-set-btn-primary"
                    disabled={saving || !source.current}
                    onClick={() => {
                      if (JSON.stringify(source.current) !== JSON.stringify(accountBinding())) {
                        setError('账号或数据源已切换，请返回原来源后重试');
                        return;
                      }
                      setSaving(true);
                      setError('');
                      void patchAccountRecords('notifications', {
                        [event]: { mode, targets: [...selected] },
                      })
                        .then(() => setOpen(false))
                        .catch((reason: unknown) =>
                          setError(reason instanceof Error ? reason.message : String(reason)),
                        )
                        .finally(() => setSaving(false));
                    }}
                  >
                    <Save size={14} aria-hidden />
                    保存选择
                  </button>
                }
              >
                <div className="weq-notification-scope-body">
                  <SegmentedControl
                    label="提醒会话范围"
                    value={mode}
                    options={[
                      { value: 'all', label: '全部适用会话' },
                      { value: 'selected', label: '指定会话' },
                    ]}
                    onChange={setMode}
                  />
                  {error && <p role="alert">{error}</p>}
                  {mode === 'selected' && (
                    <ConversationPicker
                      items={items}
                      loading={query.isLoading}
                      selected={selected}
                      onChange={setSelected}
                      emptyText="暂无适用会话"
                    />
                  )}
                  {query.error && <p role="alert">{query.error.message}</p>}
                </div>
              </PageShell>
            </div>
          )}
        </ToolSurface>
      )}
    </>
  );
}
