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
import { PageSnapshotScope } from './PageSnapshots';
import { PageScrollSnapshot } from './PageScrollSnapshot';
import { useMobileBack } from '../hooks/useMobileNavigation';
import '../styles/workspace-surfaces.css';
import '../styles/page-chrome.css';

type Placement = 'main' | 'sidecar';
type Page = {
  id: string;
  title: string;
  placement: Placement;
  close: () => void;
  navigate?: () => void;
  retainOnNavigate?: boolean;
  closable?: boolean;
  standalone?: boolean;
  mobileChrome?: boolean;
};
const PagesContext = createContext<{
  suspended: boolean;
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
  if (context?.suspended) return undefined;
  return context?.pages.find((page) => page.id === context.active)?.title;
}

export function useWorkspacePageOpen(): boolean {
  const context = useContext(PagesContext);
  return Boolean(
    !context?.suspended &&
      context?.pages.some((page) => page.id === context.active || page.placement === 'sidecar'),
  );
}

/** 「更多」下的工具页保留手机主顶栏和导航栏。 */
export function useWorkspaceMobilePage() {
  const context = useContext(PagesContext);
  if (context?.suspended) return undefined;
  return context?.pages.find((page) => page.id === context.active && page.mobileChrome);
}

export function useWorkspaceMainPageOpen(): boolean {
  const context = useContext(PagesContext);
  return Boolean(
    !context?.suspended &&
      context?.pages.some((page) => page.placement === 'main' && page.id === context.active),
  );
}

export function useWorkspaceSidecarOpen(): boolean {
  const context = useContext(PagesContext);
  return (
    !context?.suspended &&
    Boolean(context?.pages.some((page) => page.placement === 'sidecar')) &&
    !context?.pages.some((page) => page.placement === 'main' && page.id === context.active)
  );
}

export function WorkspacePages({
  navigationKey,
  suspended = false,
  onNavigate,
  children,
}: {
  navigationKey: string;
  suspended?: boolean;
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
    // 临时查看资料不关闭来源工具；返回原 navigationKey 时直接恢复现场。
    if (suspended) return;
    if (previousNavigation.current === navigationKey) return;
    previousNavigation.current = navigationKey;
    for (const page of pagesRef.current)
      if (!page.retainOnNavigate) (page.navigate ?? page.close)();
    select(null);
    navigateRef.current?.();
  }, [navigationKey, suspended]);
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
        suspended,
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
  const mainOpen = !context?.suspended && mainPages.some((page) => page.id === context?.active);
  return (
    <div className="weq-workspace-content">
      <div className="weq-workspace-split">
        <div className="weq-workspace-primary">
          <div className="weq-workspace-page-host" ref={context?.setHost} hidden={!mainOpen} />
          <div id="workspace-base-page" className="weq-workspace-base" hidden={mainOpen}>
            <TabActivity active={!mainOpen}>{children}</TabActivity>
          </div>
        </div>
        <aside
          className="weq-workspace-sidecar"
          hidden={context?.suspended || !sidecars.length || mainOpen}
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
  onNavigate,
  onBack,
  children,
  placement = 'main',
  retainOnNavigate = false,
  standalone = false,
  mobileChrome = false,
}: {
  title: string;
  onClose?: () => void;
  onNavigate?: () => void;
  onBack?: () => void;
  children: ReactNode;
  placement?: Placement;
  retainOnNavigate?: boolean;
  standalone?: boolean;
  mobileChrome?: boolean;
}) {
  const context = useContext(PagesContext);
  const id = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const navigateRef = useRef(onNavigate);
  navigateRef.current = onNavigate;
  const backRef = useRef(onBack);
  backRef.current = onBack;
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
        mobileChrome,
        close: () => closeRef.current?.(),
        navigate: () => (navigateRef.current ?? closeRef.current)?.(),
      }),
    [register, id, title, placement, retainOnNavigate, standalone, mobileChrome],
  );
  const selected =
    placement === 'sidecar'
      ? (context?.activeSidecar ??
        context?.pages.filter((page) => page.placement === 'sidecar').at(-1)?.id)
      : context?.active;
  const host = placement === 'sidecar' ? context?.sidecarHost : context?.host;
  const active =
    !context?.suspended &&
    (!context || selected === id) &&
    (placement !== 'sidecar' ||
      !context?.pages.some((page) => page.placement === 'main' && page.id === context.active));
  useMobileBack(
    active && Boolean(onClose),
    () => (backRef.current ?? closeRef.current)?.(),
    20,
    () => ref.current,
  );
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
      <TabActivity active={active}>
        {active || (context?.suspended && selected === id) ? (
          <PageSnapshotScope name={`workspace:${placement}:${title}`}>
            <PageScrollSnapshot
              style={{
                display: 'flex',
                flex: 1,
                minWidth: 0,
                minHeight: 0,
                flexDirection: 'column',
              }}
            >
              {children}
            </PageScrollSnapshot>
          </PageSnapshotScope>
        ) : null}
      </TabActivity>
    </div>
  );
  return context ? (host ? createPortal(content, host) : null) : content;
}
