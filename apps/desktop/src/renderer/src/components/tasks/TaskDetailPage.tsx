import { useRef, type ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react';
import { useMobileBack } from '../../hooks/useMobileNavigation';
import { PageShell } from '../PageShell';

export function TaskDetailPage({
  title,
  backLabel,
  onBack,
  children,
}: {
  title: string;
  backLabel: string;
  onBack: () => void;
  children: ReactNode;
}) {
  const page = useRef<HTMLElement>(null);
  useMobileBack(true, onBack, 30, () => page.current);
  return (
    <section
      ref={page}
      className="weq-task-detail-page"
      data-mobile-workspace-detail
      aria-label={title}
    >
      <PageShell
        title={title}
        leading={
          <button type="button" className="weq-page-back" aria-label={backLabel} onClick={onBack}>
            <ChevronLeft size={22} aria-hidden />
          </button>
        }
      >
        <div className="weq-task-detail-page-body">{children}</div>
      </PageShell>
    </section>
  );
}
