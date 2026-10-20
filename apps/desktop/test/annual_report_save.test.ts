import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ExportTaskManager, exportOutputFileName, type MsgService } from '@weq/service';
import { annualReportRouter } from '../src/main/ipc/routers/annual_report';
import { annualReportExportOutput } from '../src/shared/annual_report_export';
const state = vi.hoisted(() => ({
  configId: 'source-a',
  services: {} as object,
  path: null as string | null,
  root: '',
  serverRoot: undefined as string | undefined,
  afterPick: null as (() => void) | null,
  pdf: vi.fn(async (_html: string) => Buffer.from('synthetic-pdf')),
  png: vi.fn(async (_html: string) => Buffer.from('synthetic-png')),
}));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({
    services: state.services,
    account: { context: { uin: '10001' } },
    bootstrap: {
      userConfig: {
        getSettings: () => ({ exportSaveMode: 'preset', defaultExportDir: state.root }),
      },
    },
  }),
}));
vi.mock('@weq/service', async (original) => ({
  ...(await original<typeof import('@weq/service')>()),
  getHost: () => ({
    exportRoot: state.serverRoot,
    pickSaveTarget: async () => {
      state.afterPick?.();
      return state.path ? { path: state.path, downloadId: null } : null;
    },
    pickDirectory: async () => state.root,
    renderHtmlToPdf: state.pdf,
    renderHtmlToLongPng: state.png,
  }),
}));
let manager: ExportTaskManager;
const input = {
  expectedAccountUin: '10001',
  expectedAccountConfigId: 'source-a',
  year: 2025,
  html: '<html>synthetic-report</html>',
};
beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), 'weq-report-save-'));
  state.path = null;
  state.afterPick = null;
  state.serverRoot = undefined;
  state.configId = 'source-a';
  state.pdf.mockReset().mockResolvedValue(Buffer.from('synthetic-pdf'));
  state.png.mockReset().mockResolvedValue(Buffer.from('synthetic-png'));
  manager = new ExportTaskManager({} as MsgService, join(state.root, 'tasks'));
  state.services = {
    exportManager: manager,
    accountConfig: { getRecord: () => ({ configId: state.configId }) },
  };
});
afterEach(() => rmSync(state.root, { recursive: true, force: true }));
const formats = ['html', 'pdf', 'png'] as const;
function exporter(format: (typeof formats)[number]) {
  const api = annualReportRouter.createCaller({});
  return format === 'html'
    ? api.exportHtml
    : format === 'pdf'
      ? api.exportPdf
      : api.exportLongImage;
}
it.each(formats)('%s 复用现成 HTML／捕获方法，作为真实单文件结果稍后保存', async (format) => {
  const id = await exporter(format)({ ...input, savePolicy: { mode: 'after' } });
  await vi.waitFor(() => expect(manager.getTask(id!)?.status).toBe('completed'));
  const task = manager.getTask(id!)!;
  expect(task.resource?.output).toEqual(annualReportExportOutput(input.year, format));
  expect(task.stages[0]?.label).toBe('保存报告');
  expect(task.bundleDir).toBeUndefined();
  expect(task.save?.status).toBe('pending');
  expect(readFileSync(task.filePath!, 'utf8')).toBe(
    format === 'html' ? input.html : `synthetic-${format}`,
  );
  expect(state.pdf).toHaveBeenCalledTimes(format === 'pdf' ? 1 : 0);
  expect(state.png).toHaveBeenCalledTimes(format === 'png' ? 1 : 0);
  if (format === 'pdf') expect(state.pdf).toHaveBeenCalledWith(input.html);
  if (format === 'png') expect(state.png).toHaveBeenCalledWith(input.html);
});
it.each(formats)('取消 %s 的公共位置选择不创建任务或启动渲染', async (format) => {
  expect(await exporter(format)({ ...input, savePolicy: { mode: 'before' } })).toBeNull();
  expect(manager.listTasks()).toEqual([]);
  expect(state.pdf).not.toHaveBeenCalled();
  expect(state.png).not.toHaveBeenCalled();
});
it('兼容未传策略的旧入口时采用公共默认目录，避让同名而不覆盖原件', async () => {
  const name = exportOutputFileName(annualReportExportOutput(input.year, 'html'));
  const target = join(state.root, name);
  writeFileSync(target, 'personal');
  const id = await exporter('html')(input);
  await vi.waitFor(() => expect(manager.getTask(id!)?.save?.status).toBe('saved'));
  expect(manager.getTask(id!)?.save?.path).not.toBe(target);
  expect(readFileSync(target, 'utf8')).toBe('personal');
});
it('捕获期间切换来源，不发布旧报告；旧来源也不能创建新任务', async () => {
  state.pdf.mockImplementationOnce(async () => {
    state.configId = 'source-b';
    return Buffer.from('synthetic-pdf');
  });
  const id = await exporter('pdf')({ ...input, savePolicy: { mode: 'after' } });
  await vi.waitFor(() => expect(manager.getTask(id!)?.status).toBe('failed'));
  expect(manager.getTask(id!)?.filePath).toBeUndefined();
  await expect(exporter('html')({ ...input, savePolicy: { mode: 'after' } })).rejects.toThrow(
    '数据源已切换',
  );
});
it('选择期间切换来源，不启动 PDF 捕获', async () => {
  state.path = join(state.root, 'target.pdf');
  state.afterPick = () => {
    state.configId = 'source-b';
  };
  await expect(exporter('pdf')({ ...input, savePolicy: { mode: 'before' } })).rejects.toThrow(
    '数据源已切换',
  );
  expect(state.pdf).not.toHaveBeenCalled();
  expect(manager.listTasks()).toEqual([]);
});
it('宿主不支持捕获时保留真实失败，不另换引擎或冒称成功', async () => {
  state.png.mockRejectedValueOnce(new Error('当前平台不支持长图'));
  const id = await exporter('png')({ ...input, savePolicy: { mode: 'after' } });
  await vi.waitFor(() => expect(manager.getTask(id!)?.status).toBe('failed'));
  expect(manager.getTask(id!)?.error).toContain('当前平台不支持长图');
  expect(state.pdf).not.toHaveBeenCalled();
});
it('捕获在途取消等待宿主收尾，不发布半成品或重复捕获', async () => {
  let release!: (bytes: Buffer) => void;
  state.pdf.mockImplementationOnce(
    () =>
      new Promise<Buffer>((resolve) => {
        release = resolve;
      }),
  );
  const id = await exporter('pdf')({ ...input, savePolicy: { mode: 'after' } });
  await vi.waitFor(() => expect(release).toBeDefined());
  manager.cancelTask(id!);
  release(Buffer.from('synthetic-pdf'));
  await vi.waitFor(() => expect(manager.getTask(id!)?.error).toContain('中断'));
  expect(manager.getTask(id!)?.filePath).toBeUndefined();
  expect(state.pdf).toHaveBeenCalledOnce();
});
it('Web 报告只保存到服务器根内，保持实际 HTML 扩展名', async () => {
  state.serverRoot = join(state.root, 'server');
  mkdirSync(state.serverRoot);
  const id = await exporter('html')({
    ...input,
    savePolicy: { mode: 'before', directory: 'reports' },
  });
  await vi.waitFor(() => expect(manager.getTask(id!)?.save?.status).toBe('saved'));
  expect(manager.getTask(id!)?.save?.path).toBe(
    join(
      realpathSync(state.serverRoot),
      'reports',
      exportOutputFileName(annualReportExportOutput(input.year, 'html')),
    ),
  );
  await expect(
    exporter('html')({ ...input, savePolicy: { mode: 'before', directory: '/outside' } }),
  ).rejects.toThrow();
});
