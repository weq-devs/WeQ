import { useId, type ComponentProps } from 'react';
import { useMobileWebLayout } from '../hooks/useMobileWebViewport';
import { Modal } from './Dialog';
import { PanelLoading } from './LoadingIndicator';
import { PageShell } from './PageShell';
import { WorkspacePage } from './WorkspacePages';

export function DeferredSurfaceLoading({
  title,
  onClose,
  presentation = 'modal',
  anchor,
  width,
  centered,
  embedded,
  open = true,
  standalone,
  keepMobileNavigation,
}: Pick<
  ComponentProps<typeof Modal>,
  'onClose' | 'presentation' | 'anchor' | 'width' | 'open' | 'centered'
> & {
  title: string;
  embedded?: boolean;
  standalone?: boolean;
  keepMobileNavigation?: boolean;
}) {
  const titleId = useId();
  const mobile = useMobileWebLayout();
  if (!open) return null;
  if (embedded) return <PanelLoading />;

  const body = (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageShell title={title} titleId={titleId} onClose={onClose}>
        <PanelLoading />
      </PageShell>
    </div>
  );
  if (presentation === 'page' || presentation === 'sidecar')
    return (
      <WorkspacePage
        title={title}
        onClose={onClose}
        placement={presentation === 'sidecar' ? 'sidecar' : 'main'}
        standalone={standalone}
        mobileChrome={mobile && keepMobileNavigation}
      >
        {body}
      </WorkspacePage>
    );
  return (
    <Modal
      title={title}
      labelledBy={titleId}
      presentation={presentation}
      anchor={anchor}
      width={width}
      centered={centered}
      onClose={onClose}
    >
      {body}
    </Modal>
  );
}
