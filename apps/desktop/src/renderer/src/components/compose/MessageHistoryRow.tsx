import { useId, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

export function MessageHistoryRow({
  icon,
  label,
  time,
  summary,
  onLocate,
  action,
  children,
}: {
  icon: ReactNode;
  label: string;
  time: string;
  summary: string;
  onLocate?: () => void;
  action?: ReactNode;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const previewId = useId();
  const toggle = () => setExpanded((value) => !value);
  const PreviewIcon = expanded ? ChevronUp : ChevronDown;
  const previewLabel = expanded ? '收起原消息' : '展开原消息';
  return (
    <li className="weq-history-record">
      <div className="weq-history-record-line">
        <button
          className="weq-history-summary"
          type="button"
          title={onLocate ? '定位到原消息' : previewLabel}
          aria-expanded={onLocate ? undefined : expanded}
          aria-controls={onLocate ? undefined : previewId}
          onClick={onLocate ?? toggle}
        >
          <span className="weq-history-record-icon" aria-hidden>
            {icon}
          </span>
          <span className="weq-history-record-text">
            <span className="weq-history-record-meta">
              <strong data-privacy-sensitive>{label}</strong>
              {time ? <time>{time}</time> : null}
            </span>
            <span className="weq-important-preview" data-privacy-sensitive>
              {summary.replace(/\s+/g, ' ').trim() || '消息'}
            </span>
          </span>
          {onLocate ? null : <PreviewIcon size={14} aria-hidden />}
        </button>
        {onLocate ? (
          <button
            className="icon-button"
            type="button"
            title={previewLabel}
            aria-label={previewLabel}
            aria-expanded={expanded}
            aria-controls={previewId}
            onClick={toggle}
          >
            <PreviewIcon size={14} aria-hidden />
          </button>
        ) : null}
        {action}
      </div>
      <div id={previewId} className="weq-history-record-body" hidden={!expanded}>
        {expanded ? children : null}
      </div>
    </li>
  );
}
