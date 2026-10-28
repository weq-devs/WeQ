import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exportOutputFileName, getHost } from '@weq/service';
import { getAppContext } from './context/app_context';
import { exportSavePolicyInput, prepareExportDestination } from './ipc/routers/export_save';
import type { AnalyticsExportPayload, AnalyticsExportResult } from '../shared/analytics_export';

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
    name: output.name,
    output,
    savePolicy: policy,
    run: async ({ directory, signal }) => {
      check();
      signal.throwIfAborted();
      const bytes = await render(frozen);
      check();
      signal.throwIfAborted();
      await writeFile(join(directory, fileName), bytes, { flag: 'wx', signal });
      return { total: 1, ok: 1, failed: [], fileName };
    },
  });
  return { saved: false, taskId };
}
