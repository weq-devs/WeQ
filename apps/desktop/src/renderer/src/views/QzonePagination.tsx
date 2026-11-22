import { ChevronDown, Loader2, RefreshCw } from 'lucide-react';
import { useContext, useEffect, useEffectEvent, useRef } from 'react';
import { QzonePageContext } from './qzoneShared.shared';
import '../styles/qzone-pagination.css';

export function LoadingStatus({ text = '正在加载…' }: { text?: string }) {
  return (
    <p className="weq-qzn-loading" role="status">
      <Loader2 size={16} className="weq-spin" aria-hidden />
      {text}
    </p>
  );
}

export function QzoneAutoPage({
  loading,
  showLoading = loading,
  onNext,
  delay = 0,
}: {
  loading: boolean;
  showLoading?: boolean;
  onNext: () => void;
  delay?: number;
}) {
  const { active } = useContext(QzonePageContext);
  const sentinel = useRef<HTMLDivElement>(null);
  const loadNext = useEffectEvent(() => {
    if (active && !loading) onNext();
  });
  useEffect(() => {
    const element = sentinel.current;
    if (!active || loading || !element) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const observer = new IntersectionObserver(
      (entries) => {
        clearTimeout(timer);
        if (stopped || !entries.some((entry) => entry.isIntersecting)) return;
        timer = setTimeout(() => {
          stopped = true;
          observer.disconnect();
          loadNext();
        }, delay);
      },
      { root: element.closest('.weq-qzn-scroll'), rootMargin: '300px 0px' },
    );
    observer.observe(element);
    return () => {
      stopped = true;
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [active, loading, delay]);
  return (
    <div ref={sentinel} className="weq-qzn-page-sentinel">
      {showLoading ? <LoadingStatus /> : null}
    </div>
  );
}

export function QzonePageButton({
  label,
  title,
  loading = false,
  retry = false,
  onClick,
}: {
  label: string;
  title?: string;
  loading?: boolean;
  retry?: boolean;
  onClick: () => void;
}) {
  const Icon = loading ? Loader2 : retry ? RefreshCw : ChevronDown;
  return (
    <div className="weq-qzn-page-controls">
      <button
        type="button"
        className="weq-set-btn weq-qzn-page-action"
        title={title}
        aria-label={loading ? undefined : title}
        aria-disabled={loading || undefined}
        onClick={() => {
          if (!loading) onClick();
        }}
      >
        <Icon size={15} aria-hidden className={loading ? 'weq-spin' : undefined} />
        {loading ? '正在加载…' : label}
      </button>
    </div>
  );
}
