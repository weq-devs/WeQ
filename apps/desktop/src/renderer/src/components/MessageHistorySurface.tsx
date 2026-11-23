import { useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ListFilter, X } from 'lucide-react';
import { useMobileWebLayout } from '../hooks/useMobileWebViewport';
import { useSurfaceEscapeDismissal } from '../lib/surfaceEscape';
import { OverlayLayer } from './OverlayLayer';
import { MessageHistoryClosingContext } from './MessageHistorySurface.shared';
import '../styles/important-messages.css';

export function MessageHistorySurface({
  id,
  title,
  open = true,
  onClose,
  children,
  filters,
  filtered = false,
  navigationAnchor,
}: {
  id: string;
  title: string;
  open?: boolean;
  onClose: () => void;
  children: ReactNode;
  filters?: ReactNode;
  filtered?: boolean;
  navigationAnchor?: HTMLElement | null;
}) {
  const mobile = useMobileWebLayout();
  const closing = useContext(MessageHistoryClosingContext);
  const visible = open && !closing;
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersId = useId();
  const ref = useRef<HTMLElement>(null);
  useSurfaceEscapeDismissal(ref, onClose, visible && !mobile);
  useEffect(() => {
    if (!visible) setFiltersOpen(false);
    else if (!mobile) ref.current?.focus({ preventScroll: true });
  }, [visible, mobile]);

  const content = (
    <aside
      ref={ref}
      tabIndex={-1}
      data-weq-escape-surface={visible && !mobile ? '' : undefined}
      id={id}
      className={`weq-message-history-panel ${id}`}
      aria-label={title}
      hidden={!mobile && !visible}
      inert={!visible}
    >
      <header>
        <strong>{title}</strong>
        <div className="weq-history-header-actions">
          {filters ? (
            <button
              type="button"
              className="icon-button weq-history-filter-toggle"
              title={`${filtersOpen ? '收起筛选' : '展开筛选'}${filtered ? '（筛选已生效）' : ''}`}
              aria-label={`筛选${title}`}
              aria-description={filtered ? '筛选已生效' : undefined}
              aria-expanded={filtersOpen}
              aria-controls={filtersId}
              data-filtered={filtered || undefined}
              onClick={() => setFiltersOpen((value) => !value)}
            >
              <ListFilter size={16} aria-hidden />
            </button>
          ) : null}
          <button
            type="button"
            className="icon-button"
            title={`关闭${title}`}
            aria-label={`关闭${title}`}
            onClick={onClose}
          >
            <X size={16} aria-hidden />
          </button>
        </div>
      </header>
      {filters ? (
        <div id={filtersId} className="weq-history-filter-panel" hidden={!filtersOpen}>
          {filters}
        </div>
      ) : null}
      {children}
    </aside>
  );

  return mobile ? (
    <OverlayLayer
      open={visible}
      presentation="panel"
      title={title}
      className="weq-message-history-drawer"
      onClose={onClose}
      dismissOnOutside={false}
      anchor={navigationAnchor}
    >
      {content}
    </OverlayLayer>
  ) : (
    content
  );
}
