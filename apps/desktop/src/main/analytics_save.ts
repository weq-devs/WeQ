import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { deserialize, serialize } from 'node:v8';
import { exportOutputFileName, getHost, type ResourceExportRunContext } from '@weq/service';
import { getAppContext } from './context/app_context';
import { exportSavePolicyInput, prepareExportDestination } from './ipc/routers/export_save';
import type { AnalyticsExportPayload, AnalyticsExportResult } from '../shared/analytics_export';

let analyticsRenderer: ((payload: AnalyticsExportPayload) => Promise<Buffer>) | undefined;
export function setAnalyticsRenderer(
  render: (payload: AnalyticsExportPayload) => Promise<Buffer>,
): void {
  analyticsRenderer = render;
}
export function saveAnalyticsFromWeb(
  payload: AnalyticsExportPayload,
): Promise<AnalyticsExportResult> {
  if (!analyticsRenderer)
    throw new Error('当前独立 Web 服务没有图片渲染引擎，请连接桌面端开启的 Web 服务。');
  return startAnalyticsSave(payload, analyticsRenderer);
}

/** 固定本次统计快照；选好位置后才排队捕获长图。 */
export async function startAnalyticsSave(
  payload: AnalyticsExportPayload,
  render: (payload: AnalyticsExportPayload) => Promise<Buffer>,
): Promise<AnalyticsExportResult> {
  const context = getAppContext();
  const services = context.services;
  const check = () => {
    const current = getAppContext();
    if (
      !services ||
      !payload.expectedAccountUin ||
      !payload.expectedAccountConfigId ||
      current.services !== services ||
      String(current.account?.context.uin) !== payload.expectedAccountUin ||
      services.accountConfig.getRecord()?.configId !== payload.expectedAccountConfigId
    )
      throw new Error('账号或数据源已切换，请重新导出报告。');
  };
  check();
  if (!services) throw new Error('账号未就绪');
  const frozen = structuredClone(payload);
  if (!frozen.data) throw new Error('报告数据尚未就绪，请先生成报告。');
  const output = {
    kind: 'file' as const,
    name: `${frozen.label}_${frozen.title}`,
    extension: 'png',
  };
  const settings = context.bootstrap?.userConfig.getSettings();
  const policy = await prepareExportDestination(
    exportSavePolicyInput.parse(
      frozen.savePolicy ?? { mode: settings?.exportSaveMode ?? 'before' },
    ),
    settings?.defaultExportDir,
    getHost(),
    output,
    check,
  );
  if (!policy) return { saved: false, canceled: true };
  check();
  const fileName = exportOutputFileName(output);
  const taskId = await services.exportManager.startResourceExport({
    kind: 'analytics-report',
    resume: { type: 'analytics-report', fileName },
    stagedInput: serialize(frozen),
    name: output.name,
    display: { action: '导出分析长图', subject: frozen.title, context: frozen.label },
    output,
    savePolicy: policy,
    run: (context) => runAnalyticsResource(fileName, context, check, render),
  });
  return { saved: false, taskId };
}

export async function runAnalyticsResource(
  fileName: string,
  { stagedInput, directory, signal, checkpoint }: ResourceExportRunContext,
  check: () => void,
  render = analyticsRenderer,
) {
  if (!stagedInput || basename(fileName) !== fileName || ['', '.', '..'].includes(fileName))
    throw new Error('原报告输入或输出名称不可用。');
  const path = join(directory, fileName);
  const generate = async () => {
    if (!render) throw new Error('请在提供图片渲染引擎的桌面端继续。');
    const snapshot = deserialize(stagedInput) as AnalyticsExportPayload;
    if (!snapshot?.data) throw new Error('原报告数据不可用。');
    check();
    signal.throwIfAborted();
    const bytes = await render(snapshot);
    check();
    signal.throwIfAborted();
    await writeFile(path, bytes, { flag: 'wx', signal });
  };
  if (checkpoint) await checkpoint.file(['analytics-report', fileName], path, generate);
  else await generate();
  return { total: 1, ok: 1, failed: [], fileName };
}
