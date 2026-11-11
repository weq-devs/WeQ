import { useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { TabActivity } from './RetainedTabs';
import { DraftCloseContext, useDraftClose } from '../lib/draftClose';
import '../styles/profile-workspace.css';

export function ProfileWorkspace<K extends string>({
  label,
  sections,
  selected,
  onSelect,
  render,
}: {
  label: string;
  sections: ReadonlyArray<readonly [K, string]>;
  selected: K;
  onSelect: (key: K) => void;
  render: (key: K) => ReactNode;
}) {
  const [visited, setVisited] = useState<Set<K>>(() => new Set([selected]));
  const scroll = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<K, number>());
  const closing = useDraftClose(() => {}, null);
  const parentDrafts = useContext(DraftCloseContext);
  useEffect(() => {
    const read = () => {
      const states = [...closing.drafts].map((reader) => reader());
      return {
        dirty: states.some((state) => state.dirty),
        busy: states.some((state) => state.busy),
      };
    };
    parentDrafts?.add(read);
    return () => {
      parentDrafts?.delete(read);
    };
  }, [parentDrafts, closing.drafts]);
  useEffect(() => {
    setVisited((previous) =>
      previous.has(selected) ? previous : new Set([...previous, selected]),
    );
  }, [selected]);
  useLayoutEffect(() => {
    const node = scroll.current;
    if (!node) return;
    node.scrollTop = positions.current.get(selected) ?? 0;
    return () => {
      positions.current.set(selected, node.scrollTop);
    };
  }, [selected]);
  function select(key: K) {
    if (key === selected) return;
    void closing.confirmLeave(() => {
      setVisited((previous) => new Set([...previous, key]));
      onSelect(key);
    });
  }
  return (
    <DraftCloseContext.Provider value={closing.drafts}>
      <div className="weq-contact-workspace weq-contact-workspace-v2 weq-profile-workspace">
        <nav className="weq-contact-directory" aria-label={label}>
          {sections.map(([key, title]) => (
            <button
              key={key}
              type="button"
              aria-current={selected === key ? 'page' : undefined}
              onClick={() => select(key)}
            >
              {title}
            </button>
          ))}
        </nav>
        <label className="weq-contact-directory-mobile">
          资料目录
          <select
            aria-label={label}
            value={selected}
            onChange={(event) => select(event.target.value as K)}
          >
            {sections.map(([key, title]) => (
              <option key={key} value={key}>
                {title}
              </option>
            ))}
          </select>
        </label>
        <div ref={scroll} className="weq-contact-workspace-body">
          {sections
            .filter(([key]) => visited.has(key) || key === selected)
            .map(([key, title]) => (
              <div key={key} hidden={selected !== key} aria-label={title} role="region">
                <TabActivity active={selected === key}>
                  <h2 className="weq-contact-section-title">{title}</h2>
                  {render(key)}
                </TabActivity>
              </div>
            ))}
        </div>
      </div>
    </DraftCloseContext.Provider>
  );
}
