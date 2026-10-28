// @vitest-environment node
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ExportTaskManager, type MsgService } from '@weq/service';
import { startAnalyticsSave } from '../src/main/analytics_save';
import { accountRouter } from '../src/main/ipc/routers/account';
import type { AnalyticsExportPayload } from '../src/shared/analytics_export';

const state = vi.hoisted(() => ({
  uin: '10001',
  configId: 'synthetic',
  destination: '',
  runtime: '',
  automatic: false,
  services: {} as object,
  afterPick: null as (() => void) | null,
  record: vi.fn(),
}));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({
    account: { context: { uin: state.uin } },
    services: state.services,
    bootstrap: {
      userConfig: {
        getSettings: () => ({
          exportSaveMode: state.automatic ? 'preset' : 'before',
          defaultExportDir: state.destination,
        }),
      },
      agentLabConfig: {
        resolveModels: () => ({}),
      },
    },
  }),
}));
vi.mock('../src/main/resource', () => ({ resolveResource: () => state.runtime }));
vi.mock('@weq/service', async (original) => ({
  ...(await original<typeof import('@weq/service')>()),
  getHost: () => ({
    pickSaveTarget: async () => {
      state.afterPick?.();
      return state.destination ? { path: state.destination } : null;
    },
    pickDirectory: async () => {
      state.afterPick?.();
      return state.destination || null;
    },
  }),
}));
let root: string;
let manager: ExportTaskManager;
const payload = (): AnalyticsExportPayload => ({
  kind: 'buddy',
  title: '合成好友',
  label: '好友分析',
  expectedAccountUin: '10001',
  expectedAccountConfigId: 'synthetic',
  data: { statistics: { totalMessages: 2 } },
});
const botRequest = {
  personaId: 'synthetic-persona',
  adapterType: 'napcat' as const,
  wsUrl: 'ws://127.0.0.1:8081',
  selfId: '10001',
  expectedAccountUin: '10001',
  expectedAccountConfigId: 'synthetic',
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'weq-extra-export-'));
  manager = new ExportTaskManager({} as MsgService, join(root, 'cache'));
  state.uin = '10001';
  state.configId = 'synthetic';
  state.destination = '';
  state.automatic = false;
  state.afterPick = null;
  state.runtime = join(root, 'bot.mjs');
  writeFileSync(state.runtime, '// synthetic runtime');
  state.record.mockReset();
  state.services = {
    accountConfig: { getRecord: () => ({ configId: state.configId }) },
    exportManager: manager,
    agentLab: {
      assetRoot: root,
      getPersonaRecord: () => ({
        persona: { id: botRequest.personaId, name: '合成克隆', models: {} },
        pairs: [],
      }),
      recordExport: state.record,
    },
  };
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
async function finished(taskId: string) {
  await vi.waitFor(() => expect(manager.getTask(taskId)?.status).toMatch(/completed|failed/));
  return manager.getTask(taskId)!;
}
it('取消长图位置选择时不捕获、不创建任务', async () => {
  const render = vi.fn(async (_payload: AnalyticsExportPayload) => Buffer.from('synthetic-png'));
  expect(await startAnalyticsSave(payload(), render)).toMatchObject({ canceled: true });
  expect(render).not.toHaveBeenCalled();
  expect(manager.listTasks()).toHaveLength(0);
});
it('长图固定快照后排队，公共任务生成 PNG 并按明确文件名保存', async () => {
  state.destination = join(root, 'chosen.png');
  const input = payload();
  state.afterPick = () => {
    input.title = '已变化';
  };
  const render = vi.fn(async (_payload: AnalyticsExportPayload) => Buffer.from('synthetic-png'));
  const result = await startAnalyticsSave(input, render);
  expect(result.saved).toBe(false);
  const task = await finished(result.taskId!);
  await vi.waitFor(() => expect(task.save?.status).toBe('saved'));
  expect(render.mock.calls[0]?.[0]).toMatchObject({ title: '合成好友' });
  expect(readFileSync(state.destination, 'utf8')).toBe('synthetic-png');
  expect(task.resource?.kind).toBe('analytics-report');
});
it('长图选位置期间切换数据源时不创建任务', async () => {
  state.destination = join(root, 'chosen.png');
  state.afterPick = () => {
    state.configId = 'changed';
  };
  await expect(startAnalyticsSave(payload(), async () => Buffer.from('png'))).rejects.toThrow(
    '数据源',
  );
  expect(manager.listTasks()).toHaveLength(0);
});
it('长图自动保存复用默认目录，不弹出位置选择', async () => {
  state.automatic = true;
  state.destination = join(root, 'automatic');
  mkdirSync(state.destination);
  state.afterPick = () => {
    throw new Error('自动保存不应询问位置');
  };
  const result = await startAnalyticsSave(payload(), async () => Buffer.from('synthetic-png'));
  const task = await finished(result.taskId!);
  await vi.waitFor(() => expect(task.save?.status).toBe('saved'));
  expect(readFileSync(task.save!.path!, 'utf8')).toBe('synthetic-png');
});
it('长图捕获失败留在任务中，不发布可保存的完整结果', async () => {
  state.destination = join(root, 'chosen.png');
  const result = await startAnalyticsSave(payload(), async () => {
    throw new Error('合成捕获失败');
  });
  const task = await finished(result.taskId!);
  expect(task.status).toBe('failed');
  expect(task.error).toContain('合成捕获失败');
  expect(task.filePath).toBeUndefined();
});
it('机器人取消位置选择不创建任务或更新运行配置', async () => {
  expect(await accountRouter.createCaller({}).exportAgentLabPersona(botRequest)).toMatchObject({
    canceled: true,
  });
  expect(manager.listTasks()).toHaveLength(0);
  expect(state.record).not.toHaveBeenCalled();
});
it('机器人整包进入公共任务，原打包器产物和运行配置均保留', async () => {
  state.destination = join(root, 'saved');
  mkdirSync(state.destination);
  const result = await accountRouter.createCaller({}).exportAgentLabPersona(botRequest);
  if (result.canceled) throw new Error('不应取消');
  const task = await finished(result.taskId);
  expect(task.status).toBe('completed');
  await vi.waitFor(() => expect(task.save?.status).toBe('saved'));
  const config = JSON.parse(readFileSync(join(task.save!.path!, 'files', 'config.json'), 'utf8'));
  expect(config.adapter.wsUrl).toBe(botRequest.wsUrl);
  expect(config.selfId).toBe(botRequest.selfId);
  expect(state.record).toHaveBeenCalledWith(
    botRequest.personaId,
    expect.objectContaining({ taskId: result.taskId, id: config.webui.id }),
  );
  const recorded = state.record.mock.calls[0]?.[1] as { outDir: string };
  expect(readFileSync(join(recorded.outDir, 'bot.mjs'), 'utf8')).toContain('synthetic runtime');
  expect(task.resource?.kind).toBe('persona-bot');
});
it('机器人选目录期间切号，不生成旧账号任务', async () => {
  state.destination = root;
  state.afterPick = () => {
    state.uin = '10002';
  };
  await expect(accountRouter.createCaller({}).exportAgentLabPersona(botRequest)).rejects.toThrow(
    '账号已切换',
  );
  expect(manager.listTasks()).toHaveLength(0);
});
