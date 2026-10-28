import { useEffect, useRef, type ReactNode } from 'react';
import { usePageState } from '../PageSnapshots';
import { pageValue } from '../../lib/pageSnapshots';
import { useTabActive } from '../RetainedTabs';
import type { ResolvedSettingsTarget, SettingsPageId } from './navigation';
import { revealSetting } from './searchTarget';

/** 页面由 RetainedTabs 保留；失活时不保留搜索观察器，再次进入不重复跳到旧命中。 */
export function RetainedSettingsPage({
  pageId,
  target,
  children,
  revision = 0,
}: {
  pageId: SettingsPageId;
  target: ResolvedSettingsTarget;
  children: ReactNode;
  revision?: number;
}) {
  const active = useTabActive();
  const root = useRef<HTMLDivElement>(null);
  const [applied, setApplied] = usePageState<string | null>(
    'search-applied',
    null,
    pageValue.optionalString,
  );
  const request = JSON.stringify([target, revision]);
  useEffect(() => {
    if (
      !active ||
      !root.current ||
      target.section !== pageId ||
      (!target.item && !target.settingId)
    )
      return;
    if (applied !== request)
      root.current.dispatchEvent(new Event('weq-page-navigation', { bubbles: true }));
    return revealSetting(root.current, target, {
      navigate: applied !== request,
      onLocated: () => {
        if (applied !== request) setApplied(request);
      },
    });
  }, [active, target, pageId, applied, request, setApplied]);
  return (
    <div
      hidden={!active}
      inert={!active}
      ref={root}
      data-settings-page={pageId}
      className={`weq-settings-page${active ? ' weq-settings-body' : ''}`}
    >
      {children}
    </div>
  );
}
