import type { ReactElement, ReactNode } from 'react';
import { BarChart3, CalendarDays, Clock3, FileQuestion } from 'lucide-react';
import type { ReportPageManifest } from '@weq/service';

type PageProps = {
  page: ReportPageManifest;
  data: unknown;
};

function PageFrame({
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

function OverviewPage({ page, data }: PageProps): ReactElement {
  const value = data as {
    totalMessages?: number;
    activeDays?: number;
    firstMessage?: { preview?: string } | null;
    lastMessage?: { preview?: string } | null;
  };
  return (
    <PageFrame page={page}>
      <div className="weq-report-overview-grid">
        <div className="weq-report-stat">
          <BarChart3 size={22} aria-hidden />
          <strong>{value.totalMessages ?? 0}</strong>
          <span>条消息</span>
        </div>
        <div className="weq-report-stat">
          <CalendarDays size={22} aria-hidden />
          <strong>{value.activeDays ?? 0}</strong>
          <span>个活跃日</span>
        </div>
      </div>
      <div className="weq-report-quote-list">
        <p>最早的一句：{value.firstMessage?.preview || '等待真实统计接入'}</p>
        <p>最近的一句：{value.lastMessage?.preview || '等待真实统计接入'}</p>
      </div>
    </PageFrame>
  );
}

function HoursPage({ page, data }: PageProps): ReactElement {
  const counts = (data as { hourlyCounts?: Record<number, number> }).hourlyCounts ?? {};
  const max = Math.max(1, ...Object.values(counts));
  return (
    <PageFrame page={page}>
      <div className="weq-report-hours" aria-label="24 小时消息分布">
        {Array.from({ length: 24 }, (_, hour) => {
          const count = counts[hour] ?? 0;
          return (
            <div className="weq-report-hour" key={hour} title={`${hour}:00 · ${count} 条`}>
              <span style={{ height: `${Math.max(4, (count / max) * 100)}%` }} />
              <small>{hour}</small>
            </div>
          );
        })}
      </div>
      <div className="weq-report-empty-note">
        <Clock3 size={18} aria-hidden />
        <span>
          {Object.keys(counts).length
            ? '这些时刻，聊天最容易发生。'
            : '真实时段统计将在数据核心接入后显示。'}
        </span>
      </div>
    </PageFrame>
  );
}

function HeatmapPage({ page, data }: PageProps): ReactElement {
  const counts = (data as { dailyCounts?: Record<string, number> }).dailyCounts ?? {};
  const days = Object.entries(counts).slice(-84);
  const max = Math.max(1, ...days.map(([, count]) => count));
  return (
    <PageFrame page={page}>
      <div className="weq-report-heatmap" aria-label="年度消息热力图">
        {days.length ? (
          days.map(([date, count]) => (
            <span
              key={date}
              title={`${date} · ${count} 条`}
              style={{ opacity: 0.25 + (count / max) * 0.75 }}
            />
          ))
        ) : (
          <span className="weq-report-heatmap-placeholder">年度热力图</span>
        )}
      </div>
      <div className="weq-report-empty-note">
        <CalendarDays size={18} aria-hidden />
        <span>
          {days.length
            ? '每一个亮起的格子，都是留下记录的一天。'
            : '真实日历数据将在数据核心接入后显示。'}
        </span>
      </div>
    </PageFrame>
  );
}

function UnknownPage({ page }: PageProps): ReactElement {
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

export const pageRegistry: Record<string, (props: PageProps) => ReactElement> = {
  overview: OverviewPage,
  hours: HoursPage,
  heatmap: HeatmapPage,
};

export function renderReportPage(page: ReportPageManifest, data: unknown): ReactElement {
  const Component = pageRegistry[page.id] ?? UnknownPage;
  return <Component page={page} data={data} />;
}
