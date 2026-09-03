import type { ReactElement } from 'react';
import { FileQuestion } from 'lucide-react';
import type { IntimacyPageData, ReportPageManifest } from '@weq/service';
import { PageFrame } from './pageFrame';
import { IntimacyPage } from './pages/IntimacyPage';

type RegistryProps = { page: ReportPageManifest; data: unknown };
type PageRenderer = (props: RegistryProps) => ReactElement;

function UnknownPage({ page }: { page: ReportPageManifest }): ReactElement {
  return (
    <PageFrame page={page}>
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
  intimacy: ({ page, data }) => <IntimacyPage page={page} data={data as IntimacyPageData} />,
};

export function renderReportPage(page: ReportPageManifest, data: unknown): ReactElement {
  const render = pageRegistry[page.id];
  return render ? render({ page, data }) : <UnknownPage page={page} />;
}
