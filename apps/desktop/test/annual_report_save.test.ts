// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ExportTaskManager, exportOutputFileName, type MsgService } from '@weq/service';
import { annualReportRouter } from '../src/main/ipc/routers/annual_report';
import { backgroundTasks } from '../src/main/background_tasks';
import { runResumableExport } from '../src/main/resumable_exports';
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
  slides: vi.fn(async () => [Buffer.from('synthetic-slide')]),
}));
vi.mock('../src/main/context/app_context', () => ({
  requirePlatform: () => ({ appDataRoot: () => state.root }),
  accountRuntimeCacheRoot: () => state.root,
  getAppContext: () => ({
    services: state.services,
    account: { context: { uin: '10001' }, msgDbPath: '/fixture/msg.db' },
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
    renderHtmlToSlidesPng: state.slides,
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
  state.slides.mockReset().mockResolvedValue([Buffer.from('synthetic-slide')]);
  manager = new ExportTaskManager({} as MsgService, join(state.root, 'tasks'));
  state.services = {
    exportManager: manager,
    accountConfig: { getRecord: () => ({ uin: '10001', configId: state.configId }) },
  };
});

it('报告捕获中断后新管理器读取原始快照，不需要重新选择或生成 HTML', async () => {
  state.pdf.mockRejectedValueOnce(new Error('合成的捕获中断'));
  const taskId = (await exporter('pdf')({
    ...input,
    savePolicy: { mode: 'before', directory: state.root },
  }))!;
  await vi.waitFor(() => expect(manager.getTask(taskId)?.status).toBe('failed'));
  const resumed = new ExportTaskManager({} as MsgService, join(state.root, 'tasks'), {
    resumeResource: (request, context) =>
      runResumableExport(
        state.services as Parameters<typeof runResumableExport>[0],
        request,
        context,
        () => {},
      ),
  });
  expect(resumed.resumeTask(taskId)).toBe(true);
  await vi.waitFor(() => expect(resumed.getTask(taskId)?.save?.status).toBe('saved'));
  expect(state.pdf.mock.calls).toEqual([[input.html], [input.html]]);
  expect(readFileSync(resumed.getTask(taskId)!.filePath!, 'utf8')).toBe('synthetic-pdf');
});

it('分享到空间时可以续做未提交的准备阶段，发表结果不明时保留回执', async () => {
  const uploadQzoneImage = vi.fn(async () => ({ richval: 'synthetic-richval' }));
  const publishQzone = vi.fn(async () => {
    throw new Error('合成的发表回执丢失');
  });
  Object.assign(state.services, {
    profile: { getSelfProfile: async () => ({ nick: '合成账号' }) },
    webQuery: { uploadQzoneImage, publishQzone },
  });
  state.slides.mockRejectedValueOnce(new Error('合成的渲染失败'));
  const { taskId } = await annualReportRouter.createCaller({}).shareQzone({
    ...input,
    content: '合成说说',
    slideIndexes: [0],
    ugcRight: 1,
  });
  const task = () => backgroundTasks.snapshot().find((row) => row.id === taskId);
  try {
    expect(task()).toMatchObject({ status: 'paused', actions: [{ id: 'continue' }] });
    expect(uploadQzoneImage).not.toHaveBeenCalled();
    await backgroundTasks.act(taskId, 'continue');
    await vi.waitFor(() =>
      expect(task()).toMatchObject({
        status: 'failed',
        needsConfirmation: true,
        actions: [],
      }),
    );
    expect(uploadQzoneImage).toHaveBeenCalledOnce();
    expect(publishQzone).toHaveBeenCalledOnce();
  } finally {
    backgroundTasks.remove(taskId);
  }
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
it.each(formats)('%s 复用现成 HTML／捕获方法，按已选位置保存真实单文件', async (format) => {
  const id = await exporter(format)({
    ...input,
    savePolicy: { mode: 'before', directory: state.root },
  });
  await vi.waitFor(() => expect(manager.getTask(id!)?.save?.status).toBe('saved'));
  const task = manager.getTask(id!)!;
  expect(task.resource?.output).toEqual(annualReportExportOutput(input.year, format));
  expect(task.stages[0]?.label).toBe('保存报告');
  expect(task.bundleDir).toBeUndefined();
  expect(task.save?.status).toBe('saved');
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
  const id = await exporter('pdf')({
    ...input,
    savePolicy: { mode: 'before', directory: state.root },
  });
  await vi.waitFor(() => expect(manager.getTask(id!)?.status).toBe('failed'));
  expect(manager.getTask(id!)?.filePath).toBeUndefined();
  await expect(
    exporter('html')({ ...input, savePolicy: { mode: 'before', directory: state.root } }),
  ).rejects.toThrow('数据源已切换');
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
  const id = await exporter('png')({
    ...input,
    savePolicy: { mode: 'before', directory: state.root },
  });
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
  const id = await exporter('pdf')({
    ...input,
    savePolicy: { mode: 'before', directory: state.root },
  });
  await vi.waitFor(() => expect(release).toBeDefined());
  expect(manager.cancelTask(id!)).toBe(true);
  release(Buffer.from('synthetic-pdf'));
  await (manager as unknown as { queue: Promise<void> }).queue;
  expect(manager.getTask(id!)?.status).toBe('cancelled');
  expect(manager.listTasks().find((task) => task.id === id)?.canResume).toBe(true);
  expect(manager.getTask(id!)?.error).toBeUndefined();
  expect(manager.getTask(id!)?.filePath).toBeUndefined();
  expect(state.pdf).toHaveBeenCalledOnce();
  expect(manager.resumeTask(id!)).toBe(true);
  await (manager as unknown as { queue: Promise<void> }).queue;
  expect(manager.getTask(id!)?.status).toBe('completed');
  expect(state.pdf).toHaveBeenCalledTimes(2);
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
