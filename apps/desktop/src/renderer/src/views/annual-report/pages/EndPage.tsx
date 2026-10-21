import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { FileCode2, FileImage, FileText, LoaderCircle, Share2 } from 'lucide-react';
import type { EndPageData, ExportSavePolicy } from '@weq/service';
import { isAllTimeYear, reportPeriodLabel } from '@weq/service/report-time';
import { client } from '../../../trpc/client';
import { useToast } from '../../../components/Toast';
import { PageFrame, type ReportPageProps } from '../pageFrame';
import { useReportView } from '../reportContext';
import { buildReportHtml, preloadReportAssets } from '../exportHtml';
import { QzoneShareLightbox } from '../QzoneShareLightbox';
import type { AnalysisScope } from '../../analysis/model';
import { useExportSavePolicy } from '../../../hooks/useExportSavePolicy';
import { ExportSaveActions } from '../../../components/ExportSaveActions';
import { ServerSavePrompt } from '../../../components/ServerSavePrompt';
import { IS_WEB } from '../../../lib/target';
import { annualReportExportOutput } from '../../../../../shared/annual_report_export';
import '../../../styles/annual-report-save.css';

type ExportKind = 'long' | 'html' | 'pdf';

/** 一条协议 URL → base64 → data URI。解析失败返回 null（该处退回排印）。 */
async function resolveAssetDataUri(url: string, scope?: AnalysisScope): Promise<string | null> {
  const base64 = await client.account.annualReport.resolveMediaBase64.mutate({ url, ...scope });
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
  const { year, slides, readScope, overlayHostRef } = useReportView();
  const save = useExportSavePolicy();
  const identity = useMemo(() => ({}), [year, slides, readScope]);
  const latest = useRef(identity);
  latest.current = identity;
  const cancelLocation = useRef(save.chooseServerLocation);
  cancelLocation.current = save.chooseServerLocation;
  useEffect(() => {
    cancelLocation.current(null);
  }, [identity]);
  const pending = useRef(false);
  const source = useRef<{ identity: object; scope: AnalysisScope | null }>({
    identity,
    scope: readScope ?? save.binding,
  });
  if (source.current.identity !== identity)
    source.current = { identity, scope: readScope ?? save.binding };
  if (!source.current.scope && save.binding) source.current.scope = { ...save.binding };
  const reportScope = source.current.scope;
  const scopeMatches = Boolean(
    reportScope &&
      save.binding &&
      reportScope.expectedAccountUin === save.binding.expectedAccountUin &&
      reportScope.expectedAccountConfigId === save.binding.expectedAccountConfigId,
  );
  const pushToast = useToast((s) => s.push);
  const [busy, setBusy] = useState<ExportKind | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  /** QQ 是否在线。分享走 qzone web cgi，需要在线实例（ptlogin2 可兜底取 p_skey）。 */
  const [qqOnline, setQqOnline] = useState(false);
  const allTime = isAllTimeYear(year);

  /**
   * 分享按钮只在能真拿到 qzone p_skey 时出现：有在线 QQ 实例即可（ptlogin
   * 本地快速登录兜底，不要求自动读取已开启）。进入结尾页时现查一次，QQ 中途
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
  const [cachedHtml, setHtml] = useState<{ identity: object; html: string } | null>(null);
  const html = cachedHtml?.identity === identity ? cachedHtml.html : '';
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!reportScope) return;
      await preloadReportAssets(slides, (url) => resolveAssetDataUri(url, reportScope));
      if (!cancelled) setHtml({ identity, html: buildReportHtml(year, slides) });
    })();
    return () => {
      cancelled = true;
    };
  }, [year, slides, reportScope, identity]);

  /** 预热 + 拼 HTML（runExport 的兜底路径，正常时 html state 已就绪）。 */
  async function buildHtmlWithAssets(): Promise<string> {
    await preloadReportAssets(slides, (url) => resolveAssetDataUri(url, reportScope ?? undefined));
    return buildReportHtml(year, slides);
  }

  async function runExport(kind: ExportKind, intent?: ExportSavePolicy): Promise<void> {
    if (pending.current || !scopeMatches || !reportScope) return;
    pending.current = true;
    setBusy(kind);
    const current = () => latest.current === identity && save.isCurrent();
    const selected = { year, ...reportScope };
    try {
      const output = annualReportExportOutput(year, kind === 'long' ? 'png' : kind);
      const policy = await save.prepareSave(intent, {
        kind: 'file',
        name: output.name,
        format: output.extension,
      });
      if (!policy || !current()) return;
      const payload = html || (await buildHtmlWithAssets());
      if (!current()) return;
      const input = { ...selected, html: payload, savePolicy: policy };
      const taskId =
        kind === 'html'
          ? await client.account.annualReport.exportHtml.mutate(input)
          : kind === 'pdf'
            ? await client.account.annualReport.exportPdf.mutate(input)
            : await client.account.annualReport.exportLongImage.mutate(input);
      if (taskId && current()) pushToast({ tone: 'info', title: '报告保存任务已创建' });
    } catch (error) {
      if (current())
        pushToast({
          tone: 'error',
          title: '导出失败',
          detail: error instanceof Error ? error.message : String(error),
        });
    } finally {
      pending.current = false;
      setBusy(null);
    }
  }

  return (
    <PageFrame page={page} active={active} ghost="FIN" ghostPlacement="center">
      <div
        className="weq-end"
        onWheelCapture={(event) => {
          // 画布仍可滚动时，保留原生滚动，不交给报告舞台翻页。
          const canvas = event.currentTarget.parentElement;
          if (
            canvas &&
            ((event.deltaY > 0 &&
              canvas.scrollTop + canvas.clientHeight < canvas.scrollHeight - 1) ||
              (event.deltaY < 0 && canvas.scrollTop > 0))
          )
            event.stopPropagation();
        }}
      >
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
                <div key={option.kind} className="weq-save-action-group">
                  <button
                    type="button"
                    className="weq-end-take-btn"
                    disabled={busy != null || !scopeMatches || save.settings.isLoading}
                    onClick={() => void runExport(option.kind)}
                  >
                    {isBusy ? (
                      <LoaderCircle className="weq-report-spin" size={17} aria-hidden />
                    ) : (
                      <Icon size={17} aria-hidden />
                    )}
                    <span className="weq-end-take-name">{option.label}</span>
                    <span className="weq-end-take-hint">
                      {IS_WEB ? '保存到服务器' : option.hint}
                    </span>
                  </button>
                  <ExportSaveActions
                    disabled={busy != null || !scopeMatches || save.settings.isLoading}
                    onSelect={(intent) => void runExport(option.kind, intent)}
                    label={`${option.label} 本次保存选项`}
                    portalTarget={overlayHostRef.current}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {save.serverLocation && (
        <ServerSavePrompt
          name={save.serverLocation.name}
          onChoose={save.chooseServerLocation}
          portalTarget={overlayHostRef.current}
        />
      )}
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
