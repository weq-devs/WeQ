import type { ReactElement } from 'react';
import { FileQuestion } from 'lucide-react';
import type { EndPageData, OverviewPageData, ReportPageManifest } from '@weq/service';
import { PageFrame } from './pageFrame';
import { OverviewPage } from './pages/OverviewPage';
import { EndPage } from './pages/EndPage';

type RegistryProps = { page: ReportPageManifest; data: unknown; active: boolean };
type PageRenderer = (props: RegistryProps) => ReactElement;

function UnknownPage({
  page,
  active,
}: {
  page: ReportPageManifest;
  active: boolean;
}): ReactElement {
  return (
    <PageFrame page={page} active={active} eyebrow={page.category}>
      <div className="weq-report-unknown">
        <FileQuestion size={40} aria-hidden />
        <p>当前版本暂不支持这个页面。</p>
        <code>{page.id}</code>
      </div>
    </PageFrame>
  );
}

/**
 * Renderer page registry: pageId → React component. The data seam is narrowed
 * here once per page against the shared `@weq/service` data contract, so page
 * components stay fully typed while manifest page ids remain runtime strings.
 */
const pageRegistry: Record<string, PageRenderer> = {
  overview: ({ page, data, active }) => (
    <OverviewPage page={page} data={data as OverviewPageData} active={active} />
  ),
  end: ({ page, data, active }) => (
    <EndPage page={page} data={data as EndPageData} active={active} />
  ),
};

export function renderReportPage(
  page: ReportPageManifest,
  data: unknown,
  active: boolean,
): ReactElement {
  const render = pageRegistry[page.id];
  return render ? render({ page, data, active }) : <UnknownPage page={page} active={active} />;
}
