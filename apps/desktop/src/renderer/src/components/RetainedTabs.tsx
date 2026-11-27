import { useId, useState, type ReactNode } from 'react';
import { PageSnapshotScope } from './PageSnapshots';
import { PageScrollSnapshot } from './PageScrollSnapshot';
import { useTabActive, TabActivityContext } from './RetainedTabs.shared';

export function TabActivity({ active, children }: { active: boolean; children?: ReactNode }) {
  const parentActive = useTabActive();
  return (
    <TabActivityContext.Provider value={parentActive && active}>
      {children}
    </TabActivityContext.Provider>
  );
}

/** 仅挂载活动页；旧名称保留给现有调用方，现场改由轻量磁盘快照恢复。 */
export function RetainedTabs({
  activeKey,
  children,
  scrollable = false,
  snapshotKey,
  animateSwitch = false,
}: {
  activeKey: string;
  children: ReactNode;
  scrollable?: boolean;
  snapshotKey?: string;
  /** 仅供没有外层转场的同级标签页使用。 */
  animateSwitch?: boolean;
}) {
  const id = useId();
  const active = useTabActive();
  const [motion, setMotion] = useState({ key: activeKey, switching: false });
  if (animateSwitch && motion.key !== activeKey)
    setMotion({ key: activeKey, switching: active && children != null });
  if (!active || children == null) return null;
  return (
    <PageSnapshotScope key={activeKey} name={`${snapshotKey ?? id}:${activeKey}`}>
      <PageScrollSnapshot
        panel
        className={animateSwitch && motion.switching ? 'weq-surface-switch' : undefined}
        style={{
          display: 'flex',
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          flexDirection: 'column',
          height: '100%',
          overflowY: scrollable ? 'auto' : undefined,
          overflowX: scrollable ? 'hidden' : undefined,
        }}
      >
        {children}
      </PageScrollSnapshot>
    </PageSnapshotScope>
  );
}
