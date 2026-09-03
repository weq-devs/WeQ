import type { ReactElement, ReactNode } from 'react';
import type { ReportPageManifest } from '@weq/service';

/** Props every report page component receives. `data` is narrowed per page. */
export type ReportPageProps<D = unknown> = {
  page: ReportPageManifest;
  data: D;
};

export type ReportPageComponent<D = unknown> = (props: ReportPageProps<D>) => ReactElement;

/** Fixed report-page frame: category eyebrow + title + description + content. */
export function PageFrame({
  page,
  children,
}: {
  page: ReportPageManifest;
  children: ReactNode;
}): ReactElement {
  return (
    <section className="weq-report-page" aria-labelledby={`report-page-${page.id}`}>
      <div className="weq-report-page-eyebrow">{page.category}</div>
      <h1 id={`report-page-${page.id}`} className="weq-report-page-title">
        {page.title}
      </h1>
      <p className="weq-report-page-description">{page.description}</p>
      {children}
    </section>
  );
}
