import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

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

function RetainedPanel({
  active,
  children,
  scrollable,
}: {
  active: boolean;
  children: ReactNode;
  scrollable: boolean;
}) {
  const parentActive = useTabActive();
  const effectiveActive = parentActive && active;
  const scrolls = useRef(new Map<HTMLElement, { top: number; left: number }>());
  useLayoutEffect(() => {
    if (!effectiveActive) return;
    for (const [element, position] of scrolls.current) {
      if (!element.isConnected) {
        scrolls.current.delete(element);
        continue;
      }
      // ChatPane owns history anchors and follow-new-message positioning.
      if (element.matches('.message-scroll')) continue;
      element.scrollTop = position.top;
      element.scrollLeft = position.left;
    }
  }, [effectiveActive]);
  return (
    <TabActivity active={active}>
      <div
        data-retained-panel=""
        hidden={!active}
        inert={!active}
        style={{
          display: active ? 'flex' : 'none',
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          flexDirection: 'column',
          height: '100%',
          overflowY: scrollable ? 'auto' : undefined,
          overflowX: scrollable ? 'hidden' : undefined,
        }}
        onScrollCapture={(event) => {
          if (effectiveActive && event.target instanceof HTMLElement)
            scrolls.current.set(event.target, {
              top: event.target.scrollTop,
              left: event.target.scrollLeft,
            });
        }}
      >
        {children}
      </div>
    </TabActivity>
  );
}

/** Only mount visited tabs; keep the last props of hidden tabs until they are activated again. */
export function RetainedTabs({
  activeKey,
  children,
  scrollable = false,
}: {
  activeKey: string;
  children: ReactNode;
  scrollable?: boolean;
}) {
  const [panels, setPanels] = useState(() => new Map<string, ReactNode>());
  let rendered = panels;
  if (children != null && panels.get(activeKey) !== children) {
    // Render-state updates are discarded with an interrupted tab transition; mutable refs are not.
    rendered = new Map(panels);
    rendered.set(activeKey, children);
    setPanels(rendered);
  }
  return [...rendered].map(([key, content]) => (
    <RetainedPanel key={key} active={key === activeKey && children != null} scrollable={scrollable}>
      {content}
    </RetainedPanel>
  ));
}
