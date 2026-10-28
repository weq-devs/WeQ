import { createContext, useContext, useId, type ReactNode } from 'react';
import { PageSnapshotScope } from './PageSnapshots';
import { PageScrollSnapshot } from './PageScrollSnapshot';

const TabActivityContext = createContext(true);
export const useTabActive = () => useContext(TabActivityContext);

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
}: {
  activeKey: string;
  children: ReactNode;
  scrollable?: boolean;
  snapshotKey?: string;
}) {
  const id = useId();
  const active = useTabActive();
  if (!active || children == null) return null;
  return (
    <PageSnapshotScope key={activeKey} name={`${snapshotKey ?? id}:${activeKey}`}>
      <PageScrollSnapshot
        panel
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
