import type { ReactElement } from 'react';
import { FileQuestion } from 'lucide-react';
import type {
  DressPageData,
  EndPageData,
  FriendsPageData,
  HomePageData,
  InteractionsPageData,
  MatePageData,
  MonthsPageData,
  OpenersPageData,
  OverviewPageData,
  ReportPageManifest,
  RhythmPageData,
  VoicePageData,
  SparkPageData,
  QzoneMemoriesPageData,
} from '@weq/service';
import { PageFrame } from './pageFrame';
import { OverviewPage } from './pages/OverviewPage';
import { DressPage } from './pages/DressPage';
import { EndPage } from './pages/EndPage';
import { SparkPage } from './pages/SparkPage';
import { FriendsPage } from './pages/FriendsPage';
import { OpenersPage } from './pages/OpenersPage';
import { RhythmPage } from './pages/RhythmPage';
import { VoicePage } from './pages/VoicePage';
import { HomePage } from './pages/HomePage';
import { InteractionsPage } from './pages/InteractionsPage';
import { MonthsPage } from './pages/MonthsPage';
import { MatePage } from './pages/MatePage';
import { QzoneMemoriesPage } from './pages/QzoneMemoriesPage';

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
    <PageFrame page={page} active={active}>
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
  dress: ({ page, data, active }) => (
    <DressPage page={page} data={data as DressPageData} active={active} />
  ),
  spark: ({ page, data, active }) => (
    <SparkPage page={page} data={data as SparkPageData} active={active} />
  ),
  friends: ({ page, data, active }) => (
    <FriendsPage page={page} data={data as FriendsPageData} active={active} />
  ),
  openers: ({ page, data, active }) => (
    <OpenersPage page={page} data={data as OpenersPageData} active={active} />
  ),
  rhythm: ({ page, data, active }) => (
    <RhythmPage page={page} data={data as RhythmPageData} active={active} />
  ),
  voice: ({ page, data, active }) => (
    <VoicePage page={page} data={data as VoicePageData} active={active} />
  ),
  home: ({ page, data, active }) => (
    <HomePage page={page} data={data as HomePageData} active={active} />
  ),
  interactions: ({ page, data, active }) => (
    <InteractionsPage page={page} data={data as InteractionsPageData} active={active} />
  ),
  months: ({ page, data, active }) => (
    <MonthsPage page={page} data={data as MonthsPageData} active={active} />
  ),
  mate: ({ page, data, active }) => (
    <MatePage page={page} data={data as MatePageData} active={active} />
  ),
  qzone: ({ page, data, active }) => (
    <QzoneMemoriesPage page={page} data={data as QzoneMemoriesPageData} active={active} />
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
