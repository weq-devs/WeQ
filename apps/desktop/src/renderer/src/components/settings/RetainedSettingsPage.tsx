import { useEffect, useRef, type ReactNode } from 'react';
import { usePageState } from '../PageSnapshots';
import { pageValue } from '../../lib/pageSnapshots';
import { useTabActive } from '../RetainedTabs';
import type { ResolvedSettingsTarget, SettingsPageId } from './navigation';
import { revealSetting } from './searchTarget';
import { SettingsResetProvider } from './SettingsReset';

/** 页面由 RetainedTabs 保留；失活时不保留搜索观察器，再次进入不重复跳到旧命中。 */
export function RetainedSettingsPage({
  pageId,
  target,
  children,
  revision = 0,
  recordId,
}: {
  pageId: SettingsPageId;
  target: ResolvedSettingsTarget;
  children: ReactNode;
  revision?: number;
  recordId?: string;
}) {
  const active = useTabActive();
  const root = useRef<HTMLDivElement>(null);
  const [applied, setApplied] = usePageState<string | null>(
    'search-applied',
    null,
    pageValue.optionalString,
  );
  const { section, item, settingId } = target;
  const request = JSON.stringify([target, revision, recordId]);
  useEffect(() => {
    if (!active || !root.current || section !== pageId || (!item && !settingId && !recordId))
      return;
    if (applied !== request)
      root.current.dispatchEvent(new Event('weq-page-navigation', { bubbles: true }));
    return revealSetting(
      root.current,
      { item, settingId, recordId },
      {
        navigate: applied !== request,
        onLocated: () => {
          if (applied !== request) setApplied(request);
        },
      },
    );
  }, [active, section, item, settingId, pageId, applied, request, setApplied, recordId]);
  return (
    <div
      hidden={!active}
      inert={!active}
      ref={root}
      data-settings-page={pageId}
      className={`weq-settings-page${active ? ' weq-settings-body' : ''}`}
    >
      <SettingsResetProvider page={pageId}>{children}</SettingsResetProvider>
    </div>
  );
}
