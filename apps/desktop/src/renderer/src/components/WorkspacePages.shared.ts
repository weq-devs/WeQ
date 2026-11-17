import { createContext, useContext } from 'react';
import '../styles/workspace-surfaces.css';
import '../styles/page-chrome.css';

export type Placement = 'main' | 'sidecar';
export type Page = {
  id: string;
  title: string;
  placement: Placement;
  close: () => void;
  navigate?: () => void;
  retainOnNavigate?: boolean;
  closable?: boolean;
  standalone?: boolean;
  mobileChrome?: boolean;
  suspended?: boolean;
};
export const PagesContext = createContext<{
  preservedPages: ReadonlySet<string>;
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
  return context?.pages.find((page) => !page.suspended && page.id === context.active)?.title;
}

export function useWorkspacePageOpen(): boolean {
  const context = useContext(PagesContext);
  return Boolean(
    context?.pages.some(
      (page) => !page.suspended && (page.id === context.active || page.placement === 'sidecar'),
    ),
  );
}

/** 「更多」下的工具页保留手机主顶栏和导航栏。 */
export function useWorkspaceMobilePage() {
  const context = useContext(PagesContext);
  return context?.pages.find(
    (page) => !page.suspended && page.id === context.active && page.mobileChrome,
  );
}

export function useWorkspaceMainPageOpen(): boolean {
  const context = useContext(PagesContext);
  return Boolean(
    context?.pages.some(
      (page) => !page.suspended && page.placement === 'main' && page.id === context.active,
    ),
  );
}

export function useWorkspaceSidecarOpen(): boolean {
  const context = useContext(PagesContext);
  return (
    Boolean(context?.pages.some((page) => !page.suspended && page.placement === 'sidecar')) &&
    !context?.pages.some(
      (page) => !page.suspended && page.placement === 'main' && page.id === context.active,
    )
  );
}
