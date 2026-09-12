import { useEffect, useState, type ReactElement } from 'react';
import { FileCode2, FileImage, FileText, LoaderCircle, Share2 } from 'lucide-react';
import type { EndPageData } from '@weq/service';
import { isAllTimeYear, reportPeriodLabel } from '@weq/service/report-time';
import { client } from '../../../trpc/client';
import { useToast } from '../../../components/Toast';
import { PageFrame, type ReportPageProps } from '../pageFrame';
import { useReportView } from '../reportContext';
import { buildReportHtml, preloadReportAssets } from '../exportHtml';
import { QzoneShareLightbox } from '../QzoneShareLightbox';

type ExportKind = 'long' | 'html' | 'pdf';

/** 一条协议 URL → base64 → data URI。解析失败返回 null（该处退回排印）。 */
async function resolveAssetDataUri(url: string): Promise<string | null> {
  const base64 = await client.account.annualReport.resolveMediaBase64.mutate({ url });
  if (!base64) return null;
  // 按 base64 前缀挑 MIME：png / jpeg / gif / webp（协议层只回图片字节）。
  const mime = base64.startsWith('iVBOR')
    ? 'image/png'
    : base64.startsWith('/9j/')
      ? 'image/jpeg'
      : base64.startsWith('R0lGOD')
        ? 'image/gif'
        : base64.startsWith('UklGR')
          ? 'image/webp'
          : 'image/png';
  return `data:${mime};base64,${base64}`;
}

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
  const [shareOpen, setShareOpen] = useState(false);
  /** QQ 是否在线。分享走 qzone web cgi，需要在线实例（ptlogin2 可兜底取 p_skey）。 */
  const [qqOnline, setQqOnline] = useState(false);
  const allTime = isAllTimeYear(year);

  /**
   * 分享按钮只在能真拿到 qzone p_skey 时出现：有在线 QQ 实例即可（ptlogin
   * 本地快速登录兜底，不要求自动注入已开启）。进入结尾页时现查一次，QQ 中途
   * 上线/下线要等下次回到这页再刷新。
   */
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setQqOnline(false);
    void client.account.getGroupAlbumAccessState
      .query()
      .then((state) => {
        if (!cancelled) setQqOnline(state.qqOnline);
      })
      .catch(() => {
        if (!cancelled) setQqOnline(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active]);

  /**
   * 自包含 HTML：先把装扮气泡 / 头像经主进程拉成 base64 内联成 data URI，
   * 再同步拼文档。任一图解析失败只是那一处退回排印表达，不阻塞导出。
   */
  const [html, setHtml] = useState('');
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await preloadReportAssets(slides, resolveAssetDataUri);
      if (!cancelled) setHtml(buildReportHtml(year, slides));
    })();
    return () => {
      cancelled = true;
    };
  }, [year, slides]);

  /** 预热 + 拼 HTML（runExport 的兜底路径，正常时 html state 已就绪）。 */
  async function buildHtmlWithAssets(): Promise<string> {
    await preloadReportAssets(slides, resolveAssetDataUri);
    return buildReportHtml(year, slides);
  }

  async function runExport(kind: ExportKind): Promise<void> {
    if (busy) return;
    setBusy(kind);
    try {
      if (kind === 'html') {
        // 预热还没跑完时现等一次，保证导出的总是带图版本。
        const payload = html || (await buildHtmlWithAssets());
        const result = await client.account.annualReport.exportHtml.mutate({
          year,
          html: payload,
        });
        pushToast({
          tone: result.saved ? 'success' : 'info',
          title: result.saved ? 'HTML 已导出' : '已取消导出',
          detail: result.path,
        });
      } else if (kind === 'pdf') {
        const payload = html || (await buildHtmlWithAssets());
        const result = await client.account.annualReport.exportPdf.mutate({
          year,
          html: payload,
        });
        pushToast({
          tone: result.saved ? 'success' : 'info',
          title: result.saved ? 'PDF 已导出' : '已取消导出',
          detail: result.path,
        });
      } else {
        // 长图与 HTML 是同一份自包含文档：主进程把它逐页截图后竖向拼成长图。
        const payload = html || (await buildHtmlWithAssets());
        const result = await client.account.annualReport.exportLongImage.mutate({
          year,
          html: payload,
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
    <PageFrame page={page} active={active} ghost="FIN" ghostPlacement="center">
      <div className="weq-end">
        <p className="weq-end-line weq-report-line" style={{ '--i': 1 } as React.CSSProperties}>
          {allTime ? '你说过的话，全都替你收好了。' : '这一年的话，都说到这里了。'}
        </p>
        <h2 className="weq-end-title weq-report-line" style={{ '--i': 2 } as React.CSSProperties}>
          The End
        </h2>
        <p className="weq-end-sub weq-report-line" style={{ '--i': 3 } as React.CSSProperties}>
          聊天记录只留在这台电脑上，哪儿也不去。
          <br />
          {allTime ? '往后的日子，我们继续写。' : '明年今天，愿你带着更好的故事再来。'}
        </p>

        <div className="weq-end-take weq-report-line" style={{ '--i': 4 } as React.CSSProperties}>
          <span className="weq-end-take-label">把这份 {reportPeriodLabel(data.year)} 带走</span>
          <div className="weq-end-take-row">
            {qqOnline ? (
              <button
                type="button"
                className="weq-end-take-btn"
                disabled={busy != null}
                onClick={() => setShareOpen(true)}
              >
                <Share2 size={17} aria-hidden />
                <span className="weq-end-take-name">分享到空间</span>
                <span className="weq-end-take-hint">一页一图发说说</span>
              </button>
            ) : null}
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
      {shareOpen ? (
        <QzoneShareLightbox
          year={year}
          slides={slides}
          getHtml={buildHtmlWithAssets}
          onClose={() => setShareOpen(false)}
        />
      ) : null}
    </PageFrame>
  );
}
