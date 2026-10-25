import { useEffect, useRef, type ReactNode } from 'react';
import { useTabActive } from '../RetainedTabs';
import type { ResolvedSettingsTarget, SettingsPageId } from './navigation';
import { revealSetting } from './searchTarget';

/** 页面由 RetainedTabs 保留；失活时不保留搜索观察器，再次进入不重复跳到旧命中。 */
export function RetainedSettingsPage({
  pageId,
  target,
  children,
}: {
  pageId: SettingsPageId;
  target: ResolvedSettingsTarget;
  children: ReactNode;
}) {
  const active = useTabActive();
  const root = useRef<HTMLDivElement>(null);
  const applied = useRef<ResolvedSettingsTarget | null>(null);
  useEffect(() => {
    if (
      !active ||
      !root.current ||
      target.section !== pageId ||
      (!target.item && !target.settingId)
    )
      return;
    return revealSetting(root.current, target, {
      navigate: applied.current !== target,
      onLocated: () => {
        applied.current = target;
      },
    });
  }, [active, target, pageId]);
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
