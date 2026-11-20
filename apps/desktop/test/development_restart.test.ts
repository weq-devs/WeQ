// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { launchDevelopment } from '../src/main/development_console';
import { DEVELOPMENT_RESTART_EXIT_CODE } from '../src/main/development_restart';
import { AUTOSTART_ARG, MANUAL_RESTART_ARG } from '../src/main/startup_window';
import desktopPackage from '../package.json';

it('真实 electron-vite 退出后由原启动器重建页面服务，两轮日志连续输出', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'weq-restart-vite-'));
  const output = join(dir, 'launches.jsonl');
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    await mkdir(join(dir, 'renderer'));
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'weq-restart-fixture',
        type: 'module',
        main: './out/main/index.js',
        devDependencies: { electron: desktopPackage.devDependencies.electron },
      }),
    );
    await writeFile(join(dir, 'renderer/index.html'), '<html>restart-page-fixture</html>');
    await writeFile(
      join(dir, 'main.js'),
      `
      import { appendFileSync } from 'node:fs';
      const restarting = process.env.WEQ_DEV_RESTART === '1';
      const url = process.env.ELECTRON_RENDERER_URL;
      const html = await (await fetch(url, { signal: AbortSignal.timeout(10000) })).text();
      appendFileSync(${JSON.stringify(output)}, JSON.stringify({
        pid: process.pid,
        args: process.argv.slice(2),
        html,
        managed: process.env.WEQ_DEV_RESTART_MANAGED
      }) + '\\n');
      console.log(restarting ? 'fixture second startup' : 'fixture first startup');
      console.error(restarting ? 'fixture second stderr' : 'fixture first stderr');
      process.exitCode = restarting ? 0 : ${DEVELOPMENT_RESTART_EXIT_CODE};
      `,
    );
    await writeFile(
      join(dir, 'electron.vite.config.mjs'),
      `export default {
        main: {build: {rollupOptions: {input: {index: 'main.js'}}}},
        renderer: {root: 'renderer', build: {rollupOptions: {input: ${JSON.stringify(join(dir, 'renderer/index.html'))}}}, server: {host: '127.0.0.1', port: 0}},
      };`,
    );

    const status = await launchDevelopment(
      process.execPath,
      [
        resolve('node_modules/electron-vite/bin/electron-vite.js'),
        'dev',
        '--',
        '--user-data-dir=fixture',
        AUTOSTART_ARG,
      ],
      dir,
      { ...process.env, ELECTRON_EXEC_PATH: process.execPath, WEQ_DEV_RESTART: undefined },
    );
    const outputText = stdout.mock.calls.map(([line]) => String(line)).join('');
    const errorText = stderr.mock.calls.map(([line]) => String(line)).join('');
    expect(status, outputText + errorText).toBe(0);
    const [first, second, unexpected] = (await readFile(output, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(unexpected).toBeUndefined();
    expect(second.pid).not.toBe(first.pid);
    expect(first.args).toEqual(['--user-data-dir=fixture', AUTOSTART_ARG]);
    expect(second.args).toEqual(['--user-data-dir=fixture', MANUAL_RESTART_ARG]);
    for (const launch of [first, second]) {
      expect(launch.html).toContain('restart-page-fixture');
      expect(launch.managed).toBe('1');
    }
    expect(outputText).toMatch(
      /fixture first startup[\s\S]*正在重启 WeQ 开发服务[\s\S]*fixture second startup/,
    );
    expect(errorText).toMatch(/fixture first stderr[\s\S]*fixture second stderr/);
    expect(errorText).not.toContain('Failed to run dependency scan');
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
