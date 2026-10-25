import { useRef, type ReactNode } from 'react';
import { DraftCloseContext, useDraftClose } from '../lib/draftClose';
import { useModalBackground } from '../lib/modalBackground';
import { OverlayLayer } from './OverlayLayer';
import { WorkspacePage } from './WorkspacePages';
import { useTabActive } from './RetainedTabs';
import '../styles/tool-surface.css';

export type ToolPresentation = 'page' | 'modal';

/** 工具只切换容器，不注册第二套工作区；设置来源必须显式选择 modal。 */
export function ToolSurface({
  title,
  onClose,
  presentation = 'page',
  draft = null,
  busy = false,
  children,
}: {
  title: string;
  onClose: () => void;
  presentation?: ToolPresentation;
  draft?: unknown;
  busy?: boolean;
  children: ReactNode | ((requestClose: () => void) => ReactNode);
}) {
  const closing = useDraftClose(onClose, draft, busy);
  const content = (
    <DraftCloseContext.Provider value={closing.drafts}>
      {typeof children === 'function' ? children(closing.requestClose) : children}
    </DraftCloseContext.Provider>
  );
  return presentation === 'modal' ? (
    <ToolModal title={title} onClose={closing.requestClose}>
      {content}
    </ToolModal>
  ) : (
    <WorkspacePage title={title} onClose={closing.requestClose}>
      {content}
    </WorkspacePage>
  );
}

function ToolModal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const active = useTabActive();
  useModalBackground(ref, active);
  return (
    <OverlayLayer presentation="modal" className="weq-tool-scrim" onClose={onClose}>
      <section
        ref={ref}
        className="weq-tool-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        {children}
      </section>
    </OverlayLayer>
  );
}
