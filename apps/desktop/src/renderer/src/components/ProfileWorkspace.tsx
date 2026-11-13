import { useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { TabActivity } from './RetainedTabs';
import { DraftCloseContext, useDraftClose } from '../lib/draftClose';
import '../styles/profile-workspace.css';

/**
 * 资料类详情（联系人 / 群）共用的「目录 + 内容」容器。
 *
 * 宽屏左侧竖目录、窄屏横向 tab 条（不再是原生 select——原生控件与应用的导航语言不一致，
 * 也没法承载选中态与小标题层级）。章节标题默认输出 17px h2，可由宿主关闭以避免重复。
 *
 * 目录类名用 `weq-profile-directory`：旧名 `weq-contact-directory` 已被联系人列表侧栏
 * （conversationLists.tsx + conversation-directory.css）占用，同名会让两套布局互相污染。
 */
export function ProfileWorkspace<K extends string>({
  label,
  sections,
  selected,
  onSelect,
  render,
  showTitle = true,
  navigation = 'directory',
  scrollTarget,
}: {
  label: string;
  sections: ReadonlyArray<readonly [K, string]>;
  selected: K;
  onSelect: (key: K) => void;
  render: (key: K) => ReactNode;
  showTitle?: boolean;
  navigation?: 'directory' | 'tabs';
  scrollTarget?: string;
}) {
  const [visited, setVisited] = useState<Set<K>>(() => new Set([selected]));
  const scroll = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<K, number>());
  const tabs = useRef<HTMLDivElement>(null);
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
  // 窄屏 tab 条：切章节后把当前项滚进可视区，避免「选中项在屏幕外」。
  useEffect(() => {
    const strip = tabs.current;
    const current = strip?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!strip || !current) return;
    const left = current.offsetLeft;
    if (
      left < strip.scrollLeft ||
      left + current.offsetWidth > strip.scrollLeft + strip.clientWidth
    )
      strip.scrollTo({ left: left - 12, behavior: 'smooth' });
  }, [selected]);
  useLayoutEffect(() => {
    const node = scroll.current;
    if (!node) return;
    node.scrollTop = positions.current.get(selected) ?? 0;
    return () => {
      positions.current.set(selected, node.scrollTop);
    };
  }, [selected]);
  useLayoutEffect(() => {
    const node = scroll.current;
    if (!node || !scrollTarget) return;
    const target = [...node.querySelectorAll<HTMLElement>('[data-profile-anchor]')].find(
      (element) => element.dataset.profileAnchor === scrollTarget && !element.closest('[hidden]'),
    );
    if (!target) return;
    const padding = Number.parseFloat(getComputedStyle(node).paddingTop) || 0;
    node.scrollTop +=
      target.getBoundingClientRect().top -
      node.getBoundingClientRect().top -
      node.clientTop -
      padding;
  }, [selected, scrollTarget]);
  function select(key: K) {
    if (key === selected) return;
    void closing.confirmLeave(() => {
      setVisited((previous) => new Set([...previous, key]));
      onSelect(key);
    });
  }
  const visible = sections.filter(([key]) => visited.has(key) || key === selected);
  return (
    <DraftCloseContext.Provider value={closing.drafts}>
      <div
        className={`weq-profile-workspace weq-contact-workspace weq-contact-workspace-v2${navigation === 'tabs' ? ' weq-profile-workspace--tabs' : ''}`}
      >
        <nav className="weq-profile-directory" aria-label={label}>
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
        <div ref={tabs} className="weq-profile-directory-tabs" role="tablist" aria-label={label}>
          {sections.map(([key, title]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={selected === key}
              className="weq-profile-directory-tab"
              onClick={() => select(key)}
            >
              {title}
            </button>
          ))}
        </div>
        <div ref={scroll} className="weq-contact-workspace-body weq-profile-workspace-body">
          {visible.map(([key, title]) => (
            <div key={key} hidden={selected !== key} aria-label={title} role="region">
              <TabActivity active={selected === key}>
                {showTitle ? <h2 className="weq-contact-section-title">{title}</h2> : null}
                {render(key)}
              </TabActivity>
            </div>
          ))}
        </div>
      </div>
    </DraftCloseContext.Provider>
  );
}
