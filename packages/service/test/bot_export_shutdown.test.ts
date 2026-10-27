import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { buildBotExport } from '../src/account/agentlab_export';
import { makeBackupPersona } from './fixtures/backup_persona';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each(['runtime', 'config'])(
  '导出入口的 %s 启动错误不将私有字段或异常堆栈打印到日志',
  async (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'weq-bot-start-log-'));
    roots.push(root);
    const runtime = join(root, 'runtime.mjs');
    writeFileSync(
      runtime,
      'export async function startBot() { throw new Error("STARTUP_PRIVATE_MARKER"); }',
    );
    const outDir = join(root, 'export');
    await buildBotExport({
      outDir,
      botRuntimeMjs: runtime,
      persona: makeBackupPersona(),
      pairs: [],
      agentlabRoot: root,
      llmProviders: [],
      ttsProviders: [],
      adapter: { type: 'napcat', wsUrl: 'ws://synthetic.invalid' },
      selfId: 'synthetic',
      features: { voice: false, groupChat: false },
    });
    if (mode === 'config')
      writeFileSync(join(outDir, 'config.json'), '{"STARTUP_PRIVATE_MARKER": broken}');
    const child = spawnSync(process.execPath, [join(outDir, 'index.mjs')], {
      cwd: outDir,
      timeout: 3000,
      killSignal: 'SIGKILL',
      encoding: 'utf8',
    });
    expect(child.status).toBe(1);
    expect(child.stderr).toContain('启动失败');
    expect(child.stderr + child.stdout).not.toContain('STARTUP_PRIVATE_MARKER');
  },
);

it.each(['SIGINT', 'SIGTERM'])(
  '导出入口收到 %s 后等待 stop，提供方期限保留在产物',
  async (signal) => {
    const root = mkdtempSync(join(tmpdir(), 'weq-bot-export-stop-'));
    roots.push(root);
    const runtime = join(root, 'runtime.mjs');
    writeFileSync(
      runtime,
      `
    import { writeFileSync } from 'node:fs';
    export async function startBot() {
      setImmediate(() => process.emit(process.env.SYNTHETIC_SIGNAL));
      return { stop: async () => {
        await new Promise(resolve => setTimeout(resolve, 25));
        writeFileSync(new URL('./stopped.txt', import.meta.url), 'stopped');
      } };
    }
  `,
    );
    const outDir = join(root, 'export');
    await buildBotExport({
      outDir,
      botRuntimeMjs: runtime,
      persona: makeBackupPersona(),
      pairs: [],
      agentlabRoot: root,
      llmProviders: [
        {
          id: 'synthetic',
          baseUrl: 'https://synthetic.invalid',
          apiKey: 'synthetic',
          timeoutMs: 600_000,
        },
      ],
      ttsProviders: [],
      adapter: { type: 'napcat', wsUrl: 'ws://synthetic.invalid' },
      selfId: 'synthetic',
      features: { voice: false, groupChat: false },
    });
    const config = JSON.parse(readFileSync(join(outDir, 'config.json'), 'utf8')) as {
      llmProviders: { timeoutMs?: number }[];
    };
    expect(config.llmProviders[0]!.timeoutMs).toBe(600_000);
    const child = spawnSync(process.execPath, [join(outDir, 'index.mjs')], {
      cwd: outDir,
      env: { ...process.env, SYNTHETIC_SIGNAL: signal },
      timeout: 3000,
      killSignal: 'SIGKILL',
      encoding: 'utf8',
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(readFileSync(join(outDir, 'stopped.txt'), 'utf8')).toBe('stopped');
  },
);
