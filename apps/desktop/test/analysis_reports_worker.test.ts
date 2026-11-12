// @vitest-environment node
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { expect, it } from 'vitest';
import type { AnalysisReportsService } from '../../../packages/service/src/account/analysis_reports';
import { resolveChildWorkerPath } from '../src/main/worker_path';

it('桌面与 Web 构建和安装包都包含报告 Worker 入口', async () => {
  expect(await readFile('electron.vite.config.ts', 'utf8')).toContain('analysisReportsWorker:');
  expect(await readFile('../web/scripts/build-server.mjs', 'utf8')).toContain(
    'analysisReportsWorker:',
  );
  expect(await readFile('electron-builder.yml', 'utf8')).toContain(
    'from: out/main/analysisReportsWorker.mjs',
  );
});

it('报告存储在实际 Vite 打包后能启动独立 Worker 并保存、重开和删除结果', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-reports-bundle-'));
  let service: AnalysisReportsService | undefined;
  try {
    await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        ssr: true,
        outDir: join(root, 'out/main'),
        rollupOptions: {
          input: {
            reports: resolve('../../packages/service/src/account/analysis_reports.ts'),
            analysisReportsWorker: resolve(
              '../../packages/service/src/account/analysis_reports_worker.mjs',
            ),
          },
          output: { entryFileNames: '[name].mjs' },
        },
      },
    });
    const module = await import(pathToFileURL(join(root, 'out/main/reports.mjs')).href);
    const worker = resolveChildWorkerPath(
      'analysisReportsWorker.mjs',
      join(root, 'app.asar/out/main'),
      root,
    );
    service = new module.AnalysisReportsService(
      root,
      async () => ({ exact: 9007199254740993n }),
      worker,
    );
    await service!.create({
      id: 'fixture',
      kind: 'buddy',
      name: '合成对象',
      peerUid: 'u_fixture',
      period: '全部',
      scope: { expectedAccountUin: '10001', expectedAccountConfigId: 'fixture' },
    });
    await service!.resume('fixture');
    await expect.poll(async () => (await service!.get('fixture')).status).toBe('completed');
    expect((await service!.get('fixture')).results.report).toEqual({ exact: 9007199254740993n });
    await service!.dispose();
    service = new module.AnalysisReportsService(root, async () => null, worker);
    expect((await service!.list()).length).toBe(1);
    expect((await service!.get('fixture')).results.report).toEqual({ exact: 9007199254740993n });
    await service!.remove('fixture');
    expect(await service!.list()).toEqual([]);
  } finally {
    await service?.dispose().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
