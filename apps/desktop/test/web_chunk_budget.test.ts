// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build, createLogger, type Plugin } from 'vite';
import { expect, it, vi } from 'vitest';

async function fixture({
  language = 'emacs-lisp',
  size = 600_000,
  eager = false,
  mixed = false,
  forged = false,
  unrelated = false,
  growLate = false,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'weq-chunk-budget-'));
  const entry = join(root, 'entry.js');
  const grammar = forged
    ? join(root, `${language}.mjs`)
    : join(root, 'node_modules/@shikijs/langs/dist', `${language}.mjs`);
  const helper = join(root, 'business.js');
  const sources = new Map([
    [
      entry,
      eager
        ? `import {payload} from ${JSON.stringify(grammar)}; console.log(payload);`
        : `import(${JSON.stringify(grammar)}).then(m=>console.log(m.payload));`,
    ],
    [
      grammar,
      `${mixed ? `import {tag} from ${JSON.stringify(helper)};console.log(tag);` : ''}export const payload=${JSON.stringify('x'.repeat(size))};`,
    ],
    [helper, 'export const tag = Math.random();'],
  ]);
  const logger = createLogger('silent');
  const warnings = vi.spyOn(logger, 'warn');
  const info = vi.spyOn(logger, 'info');
  const plugin: Plugin = {
    name: 'chunk-budget-fixture',
    resolveId: (id) => (sources.has(id) ? id : null),
    load: (id) => sources.get(id),
    buildStart() {
      if (unrelated) this.warn('fixture-unrelated');
    },
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        if (!growLate) return;
        for (const chunk of Object.values(bundle)) {
          if (chunk.type === 'chunk' && chunk.isEntry) {
            chunk.code += `\nconsole.log(${JSON.stringify('x'.repeat(600_000))});`;
          }
        }
      },
    },
  };
  try {
    await build({
      configFile: resolve(__dirname, '../../web/vite.config.ts'),
      root,
      customLogger: logger,
      logLevel: 'warn',
      plugins: [plugin],
      build: {
        outDir: join(root, 'out'),
        emptyOutDir: true,
        reportCompressedSize: false,
        rollupOptions: { input: entry },
      },
    });
    return {
      warnings: warnings.mock.calls.map(([text]) => text).join('\n'),
      info: info.mock.calls.map(([text]) => text).join('\n'),
      hasWarned: logger.hasWarned,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

it.each(['cpp', 'emacs-lisp'])(
  '已知按需语法 %s 在独立预算内只记 INFO，不标记构建警告',
  async (language) => {
    const output = await fixture({ language });
    expect(output.warnings).toBe('');
    expect(output.hasWarned).toBe(false);
    expect(output.info).toContain('按需语法资源');
    expect(output.info).toContain(language);
  },
);

it.each([
  { forged: true },
  { mixed: true },
  { eager: true },
  { language: 'python' },
  { size: 950_000 },
  { growLate: true },
])('伪装、混包、提前加载、未知语法或超预算仍告警：%j', async (options) => {
  const output = await fixture(options);
  expect(output.warnings).toContain('构建块超出体积预算');
  expect(output.hasWarned).toBe(true);
});

it('已知语法不掩盖其他构建警告', async () => {
  const output = await fixture({ unrelated: true });
  expect(output.warnings).toContain('fixture-unrelated');
  expect(output.warnings).not.toContain('Some chunks are larger');
});
