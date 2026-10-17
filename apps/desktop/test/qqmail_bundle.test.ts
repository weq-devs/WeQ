// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { externalizeDepsPlugin } from 'electron-vite';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';

describe('邮箱 WebSocket 桌面运行时', () => {
  it('ws 是随桌面端安装的生产依赖，构建保留 Node 可选模块回退', async () => {
    const desktop = resolve(__dirname, '..');
    const manifest = JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8'));
    expect(manifest.dependencies.ws).toBeDefined();
    const entry = '\0weq-mail-runtime-test';
    const result = await build({
      configFile: false,
      root: desktop,
      logLevel: 'silent',
      plugins: [
        externalizeDepsPlugin(),
        {
          name: 'mail-runtime-fixture',
          resolveId: (id) => (id === entry ? entry : null),
          load: (id) =>
            id === entry
              ? 'import WebSocket from "ws"; console.log(JSON.stringify({available: typeof WebSocket === "function"}));'
              : null,
        },
      ],
      build: {
        ssr: true,
        write: false,
        minify: false,
        rollupOptions: { input: entry, output: { format: 'es' } },
      },
    });
    const output = Array.isArray(result) ? result[0] : result;
    if (!('output' in output)) throw new Error('缺少构建产物');
    const chunk = output.output.find((item) => item.type === 'chunk');
    if (chunk?.type !== 'chunk') throw new Error('缺少运行时入口');
    expect(chunk.imports).toContain('ws');
    expect(chunk.code).not.toContain('Could not resolve');
    const temporary = await mkdtemp(join(desktop, 'node_modules/.weq-mail-runtime-'));
    try {
      const file = join(temporary, 'entry.mjs');
      await writeFile(file, chunk.code);
      const response = execFileSync(process.execPath, [file], { encoding: 'utf8' });
      expect(JSON.parse(response)).toEqual({ available: true });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
