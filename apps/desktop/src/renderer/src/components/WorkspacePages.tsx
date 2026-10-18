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
import { useSurfaceEscape } from '../lib/surfaceEscape';
import { TabActivity } from './RetainedTabs';
import '../styles/workspace-surfaces.css';
import '../styles/page-chrome.css';

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

export function useWorkspaceActiveTitle(): string | undefined {
  const context = useContext(PagesContext);
  return context?.pages.find((page) => page.id === context.active)?.title;
}

export function useWorkspacePageOpen(): boolean {
  const context = useContext(PagesContext);
  return Boolean(
    context?.pages.some((page) => page.id === context.active || page.placement === 'sidecar'),
  );
}

export function useWorkspaceMainPageOpen(): boolean {
  const context = useContext(PagesContext);
  return Boolean(
    context?.pages.some((page) => page.placement === 'main' && page.id === context.active),
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
      selectPage((current) =>
        current === page.id
          ? (pagesRef.current
              .filter((item) => item.id !== page.id && item.placement === page.placement)
              .at(-1)?.id ?? null)
          : current,
      );
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

export function WorkspaceContent({ children }: { children: ReactNode }) {
  const context = useContext(PagesContext);
  const mainPages = context?.pages.filter((page) => page.placement === 'main') ?? [];
  const sidecars = context?.pages.filter((page) => page.placement === 'sidecar') ?? [];
  const mainOpen = mainPages.some((page) => page.id === context?.active);
  return (
    <div className="weq-workspace-content">
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
      role="region"
      aria-label={title}
      hidden={!active}
      tabIndex={-1}
    >
      <TabActivity active={active}>{children}</TabActivity>
    </div>
  );
  return context ? (host ? createPortal(content, host) : null) : content;
}
