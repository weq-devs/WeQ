import { useMemo, useState, type ReactElement } from 'react';
import { FileCode2, FileImage, FileText, LoaderCircle } from 'lucide-react';
import type { EndPageData } from '@weq/service';
import { isAllTimeYear, reportPeriodLabel } from '@weq/service/report-time';
import { client } from '../../../trpc/client';
import { useToast } from '../../../components/Toast';
import { PageFrame, type ReportPageProps } from '../pageFrame';
import { useReportView } from '../reportContext';
import { buildReportHtml } from '../exportHtml';

type ExportKind = 'long' | 'html' | 'pdf';

const EXPORT_OPTIONS: Array<{
  kind: ExportKind;
  label: string;
  hint: string;
  icon: typeof FileImage;
}> = [
  { kind: 'long', label: '长图', hint: '拼成一张分享图', icon: FileImage },
  { kind: 'html', label: 'HTML', hint: '离线可打开', icon: FileCode2 },
  { kind: 'pdf', label: 'PDF', hint: 'A4 逐页排版', icon: FileText },
];

/**
 * 结尾页 —— 一句收束的话 + 把报告带走的三个出口。
 * 与开篇同一套排印语言：出血描边字衬底、发丝线、逐层浮现。
 */
export function EndPage({ page, data, active }: ReportPageProps<EndPageData>): ReactElement {
  const { year, slides } = useReportView();
  const pushToast = useToast((s) => s.push);
  const [busy, setBusy] = useState<ExportKind | null>(null);
  const allTime = isAllTimeYear(year);

  const html = useMemo(() => buildReportHtml(year, slides), [year, slides]);

  async function runExport(kind: ExportKind): Promise<void> {
    if (busy) return;
    setBusy(kind);
    try {
      if (kind === 'html') {
        const result = await client.account.annualReport.exportHtml.mutate({ year, html });
        pushToast({
          tone: result.saved ? 'success' : 'info',
          title: result.saved ? 'HTML 已导出' : '已取消导出',
          detail: result.path,
        });
      } else if (kind === 'pdf') {
        const result = await client.account.annualReport.exportPdf.mutate({ year, html });
        pushToast({
          tone: result.saved ? 'success' : 'info',
          title: result.saved ? 'PDF 已导出' : '已取消导出',
          detail: result.path,
        });
      } else {
        const payload = slides.map((s) => ({
          pageId: s.page.id,
          title: s.page.title,
          description: s.page.description,
          category: s.page.category,
          data: s.data,
        }));
        const result = await client.account.annualReport.exportLongImage.mutate({
          year,
          slides: payload,
        });
        pushToast({
          tone: result.saved ? 'success' : 'info',
          title: result.saved ? '长图已导出' : '已取消导出',
          detail: result.path,
        });
      }
    } catch (error) {
      pushToast({
        tone: 'error',
        title: '导出失败',
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <PageFrame
      page={page}
      active={active}
      eyebrow={
        <>
          结尾<span className="weq-report-eyebrow-en">THE END</span>
        </>
      }
      ghost="FIN"
      ghostPlacement="center"
    >
      <div className="weq-end">
        <p className="weq-end-line weq-report-line" style={{ '--i': 1 } as React.CSSProperties}>
          {allTime ? '你说过的话，都在这里了。' : '这一年的话都说完了。'}
        </p>
        <h2 className="weq-end-title weq-report-line" style={{ '--i': 2 } as React.CSSProperties}>
          辛苦了
        </h2>
        <p className="weq-end-sub weq-report-line" style={{ '--i': 3 } as React.CSSProperties}>
          聊天记录只留在这台电脑上。
          <br />
          {allTime ? '往后的话，也还长。' : '明年这个时候，我们再看一次。'}
        </p>

        <div className="weq-end-take weq-report-line" style={{ '--i': 4 } as React.CSSProperties}>
          <span className="weq-end-take-label">把这份 {reportPeriodLabel(data.year)} 带走</span>
          <div className="weq-end-take-row">
            {EXPORT_OPTIONS.map((option) => {
              const Icon = option.icon;
              const isBusy = busy === option.kind;
              return (
                <button
                  key={option.kind}
                  type="button"
                  className="weq-end-take-btn"
                  disabled={busy != null}
                  onClick={() => void runExport(option.kind)}
                >
                  {isBusy ? (
                    <LoaderCircle className="weq-report-spin" size={17} aria-hidden />
                  ) : (
                    <Icon size={17} aria-hidden />
                  )}
                  <span className="weq-end-take-name">{option.label}</span>
                  <span className="weq-end-take-hint">{option.hint}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </PageFrame>
  );
}
