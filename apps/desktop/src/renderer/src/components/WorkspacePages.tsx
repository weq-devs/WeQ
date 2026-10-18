import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useSurfaceEscape } from '../lib/surfaceEscape';
import { TabActivity } from './RetainedTabs';
import '../styles/workspace-surfaces.css';

type Placement = 'main' | 'sidecar';
type Page = {
  id: string;
  title: string;
  placement: Placement;
  close: () => void;
  retainOnNavigate?: boolean;
  closable?: boolean;
  standalone?: boolean;
};
const PagesContext = createContext<{
  host: HTMLDivElement | null;
  setHost: (host: HTMLDivElement | null) => void;
  sidecarHost: HTMLDivElement | null;
  setSidecarHost: (host: HTMLDivElement | null) => void;
  pages: Page[];
  active: string | null;
  select: (id: string | null) => void;
  activeSidecar: string | null;
  selectSidecar: (id: string) => void;
  register: (page: Page) => () => void;
} | null>(null);

export function useWorkspacePageOpen(): boolean {
  const context = useContext(PagesContext);
  return Boolean(
    context?.pages.some((page) => page.id === context.active || page.placement === 'sidecar'),
  );
}

export function useWorkspaceSidecarOpen(): boolean {
  const context = useContext(PagesContext);
  return (
    Boolean(context?.pages.some((page) => page.placement === 'sidecar')) &&
    !context?.pages.some((page) => page.placement === 'main' && page.id === context.active)
  );
}

export function WorkspacePages({
  navigationKey,
  onNavigate,
  children,
}: {
  navigationKey: string;
  onNavigate?: () => void;
  children: ReactNode;
}) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [sidecarHost, setSidecarHost] = useState<HTMLDivElement | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [active, select] = useState<string | null>(null);
  const [activeSidecar, selectSidecar] = useState<string | null>(null);
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const previousNavigation = useRef(navigationKey);
  const navigateRef = useRef(onNavigate);
  navigateRef.current = onNavigate;
  useEffect(() => {
    if (previousNavigation.current === navigationKey) return;
    previousNavigation.current = navigationKey;
    for (const page of pagesRef.current) if (!page.retainOnNavigate) page.close();
    select(null);
    navigateRef.current?.();
  }, [navigationKey]);
  const register = useCallback((page: Page) => {
    setPages((current) => [...current.filter((item) => item.id !== page.id), page]);
    const selectPage = page.placement === 'sidecar' ? selectSidecar : select;
    selectPage(page.id);
    return () => {
      setPages((current) => current.filter((item) => item.id !== page.id));
      selectPage((current) => (current === page.id ? null : current));
    };
  }, []);
  return (
    <PagesContext.Provider
      value={{
        host,
        setHost,
        sidecarHost,
        setSidecarHost,
        pages,
        active,
        select,
        activeSidecar,
        selectSidecar,
        register,
      }}
    >
      {children}
    </PagesContext.Provider>
  );
}

function WorkspaceTabs({
  pages,
  selected,
  onSelect,
  label,
}: {
  pages: Page[];
  selected: string | undefined;
  onSelect: (id: string) => void;
  label: string;
}) {
  const tabsRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    tabsRef.current
      ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      ?.closest('.weq-workspace-tab')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selected]);
  if (!pages.length) return null;
  return (
    <div ref={tabsRef} className="weq-workspace-tabs" role="tablist" aria-label={label}>
      {pages.map((page) => (
        <div className="weq-workspace-tab" key={page.id}>
          <button
            type="button"
            role="tab"
            id={`${page.id}-tab`}
            aria-selected={selected === page.id}
            tabIndex={selected === page.id ? 0 : -1}
            aria-controls={`${page.id}-page`}
            onClick={() => onSelect(page.id)}
            onKeyDown={(event) => {
              const index = pages.findIndex((item) => item.id === page.id);
              const last = pages.length - 1;
              const next =
                event.key === 'ArrowRight'
                  ? (index + 1) % (last + 1)
                  : event.key === 'ArrowLeft'
                    ? (index + last) % (last + 1)
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? last
                        : null;
              if (next === null) return;
              event.preventDefault();
              const target = pages[next];
              if (!target) return;
              onSelect(target.id);
              event.currentTarget.ownerDocument.getElementById(`${target.id}-tab`)?.focus();
            }}
          >
            {page.title}
          </button>
          {page.closable !== false && (
            <button
              type="button"
              title={`关闭${page.title}`}
              aria-label={`关闭${page.title}`}
              onClick={page.close}
            >
              <X size={14} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

export function WorkspaceContent({ children }: { children: ReactNode }) {
  const context = useContext(PagesContext);
  const mainPages = context?.pages.filter((page) => page.placement === 'main') ?? [];
  const pages = mainPages.filter((page) => !page.standalone);
  const sidecars = context?.pages.filter((page) => page.placement === 'sidecar') ?? [];
  const mainOpen = mainPages.some((page) => page.id === context?.active);
  const standaloneOpen = mainPages.some((page) => page.id === context?.active && page.standalone);
  const tabs = pages.some((page) => page.retainOnNavigate)
    ? [
        {
          id: 'workspace-base',
          title: '当前内容',
          placement: 'main' as const,
          close: () => {},
          closable: false,
        },
        ...pages,
      ]
    : pages;
  return (
    <div className="weq-workspace-content">
      {context && !standaloneOpen && (
        <WorkspaceTabs
          pages={tabs}
          selected={context.active ?? 'workspace-base'}
          onSelect={(id) => context.select(id === 'workspace-base' ? null : id)}
          label="内容页面"
        />
      )}
      <div className="weq-workspace-split">
        <div className="weq-workspace-primary">
          <div className="weq-workspace-page-host" ref={context?.setHost} hidden={!mainOpen} />
          <div id="workspace-base-page" className="weq-workspace-base" hidden={mainOpen}>
            {children}
          </div>
        </div>
        <aside
          className="weq-workspace-sidecar"
          hidden={!sidecars.length || mainOpen}
          aria-label="会话附属内容"
        >
          {context && (
            <WorkspaceTabs
              pages={sidecars}
              selected={context.activeSidecar ?? sidecars.at(-1)?.id}
              onSelect={context.selectSidecar}
              label="会话内容"
            />
          )}
          <div className="weq-workspace-sidecar-host" ref={context?.setSidecarHost} />
        </aside>
      </div>
    </div>
  );
}

export function WorkspacePage({
  title,
  onClose,
  children,
  placement = 'main',
  retainOnNavigate = false,
  standalone = false,
}: {
  title: string;
  onClose?: () => void;
  children: ReactNode;
  placement?: Placement;
  retainOnNavigate?: boolean;
  standalone?: boolean;
}) {
  const context = useContext(PagesContext);
  const id = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const ref = useRef<HTMLDivElement>(null);
  const register = context?.register;
  useLayoutEffect(
    () =>
      register?.({
        id,
        title,
        placement,
        retainOnNavigate,
        standalone,
        close: () => closeRef.current?.(),
      }),
    [register, id, title, placement, retainOnNavigate, standalone],
  );
  const selected =
    placement === 'sidecar'
      ? (context?.activeSidecar ??
        context?.pages.filter((page) => page.placement === 'sidecar').at(-1)?.id)
      : context?.active;
  const host = placement === 'sidecar' ? context?.sidecarHost : context?.host;
  const active =
    (!context || selected === id) &&
    (placement !== 'sidecar' ||
      !context?.pages.some((page) => page.placement === 'main' && page.id === context.active));
  useSurfaceEscape(ref, onClose, active, false);
  const content = (
    <div
      ref={ref}
      id={`${id}-page`}
      className={`weq-workspace-page${placement === 'sidecar' ? ' weq-workspace-sidecar-page' : ''}${context ? '' : ' weq-workspace-page-fallback'}`}
      role={standalone ? 'region' : 'tabpanel'}
      aria-label={title}
      aria-labelledby={context && !standalone ? `${id}-tab` : undefined}
      hidden={!active}
      tabIndex={-1}
    >
      <TabActivity active={active}>{children}</TabActivity>
    </div>
  );
  return context ? (host ? createPortal(content, host) : null) : content;
}
