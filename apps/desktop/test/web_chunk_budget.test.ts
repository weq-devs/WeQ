// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
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
  earlyNativeWarning = false,
  write = true,
  directNativeWarning = '',
  compactWarning = false,
  once = false,
  customLogger = createLogger('silent'),
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
  const logger = customLogger;
  const warnings = vi.spyOn(logger, 'warn');
  const warningsOnce = vi.spyOn(logger, 'warnOnce');
  const info = vi.spyOn(logger, 'info');
  const nativeWarning = compactWarning
    ? '部分构建块压缩后超过 500 kB'
    : '\x1b[33m[plugin builtin:vite-reporter] \n(!) Some chunks are larger than 500 kB after minification. Consider:\x1b[0m';
  const emitNative = () => (once ? logger.warnOnce(nativeWarning) : logger.warn(nativeWarning));
  const plugin: Plugin = {
    name: 'chunk-budget-fixture',
    resolveId: (id) => (sources.has(id) ? id : null),
    load: (id) => sources.get(id),
    buildStart() {
      if (unrelated) this.warn('fixture-unrelated');
      if (directNativeWarning === 'before') emitNative();
    },
    writeBundle: {
      order: 'post',
      handler() {
        if (directNativeWarning === 'after') emitNative();
      },
    },
    closeBundle: {
      order: 'post',
      handler() {
        if (directNativeWarning === 'closed') emitNative();
      },
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
      plugins: [
        plugin,
        ...(earlyNativeWarning
          ? [
              {
                name: 'builtin:vite-reporter',
                buildStart() {
                  this.warn('(!) Some chunks are larger than 500 kB after minification. Consider:');
                },
              } satisfies Plugin,
            ]
          : []),
      ],
      build: {
        write,
        outDir: join(root, 'out'),
        emptyOutDir: true,
        reportCompressedSize: false,
        rollupOptions: { input: entry },
      },
    });
    return {
      warnings: [...warnings.mock.calls, ...warningsOnce.mock.calls]
        .map(([text]) => text)
        .join('\n'),
      info: info.mock.calls.map(([text]) => text).join('\n'),
      hasWarned: logger.hasWarned,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

it.each(['cpp', 'emacs-lisp'])(
  '已知按需语法 %s 在独立预算内保持静默，不标记构建警告',
  async (language) => {
    const output = await fixture({ language });
    expect(output.warnings).toBe('');
    expect(output.hasWarned).toBe(false);
    expect(output.info).not.toContain('按需语法资源');
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

it('原生警告先于预算检查到达时等待最终检查，正常资源保持静默', async () => {
  const output = await fixture({ earlyNativeWarning: true });
  expect(output.warnings).toBe('');
  expect(output.hasWarned).toBe(false);
  expect(output.info).not.toContain('按需语法资源');
});

it('原生警告先到但确实存在超预算业务块时保留明确告警', async () => {
  const output = await fixture({ earlyNativeWarning: true, forged: true });
  expect(output.warnings).toContain('构建块超出体积预算');
  expect(output.warnings).not.toContain('Some chunks are larger');
});

it('预算检查未执行时不吞掉先到的原生告警', async () => {
  const output = await fixture({ earlyNativeWarning: true, write: false });
  expect(output.warnings).toContain('Some chunks are larger');
  expect(output.hasWarned).toBe(true);
});

it.each(['before', 'after', 'closed'])(
  '原生警告直接进入 logger（%s）也由预算检查统一处理',
  async (directNativeWarning) => {
    const output = await fixture({ directNativeWarning });
    expect(output.warnings).toBe('');
    expect(output.hasWarned).toBe(false);
  },
);

it('已被压成中文摘要的原生警告也不重复输出', async () => {
  const output = await fixture({ directNativeWarning: 'after', compactWarning: true });
  expect(output.warnings).toBe('');
  expect(output.hasWarned).toBe(false);
});

it('logger.warnOnce 的原生大包警告也不重复输出', async () => {
  const output = await fixture({ directNativeWarning: 'after', once: true });
  expect(output.warnings).toBe('');
  expect(output.hasWarned).toBe(false);
});

it('复用 logger 的下一次构建仍保留未检查的原生警告', async () => {
  const logger = createLogger('silent');
  await fixture({ customLogger: logger });
  expect(logger.hasWarned).toBe(false);
  await fixture({ customLogger: logger, directNativeWarning: 'before', write: false });
  expect(logger.hasWarned).toBe(true);
});

it('直接进入 logger 但未执行预算检查的警告仍保留', async () => {
  const output = await fixture({ directNativeWarning: 'before', write: false });
  expect(output.warnings).toContain('Some chunks are larger');
  expect(output.hasWarned).toBe(true);
});

it.each(['cli', 'desktop'] as const)(
  '真实 %s 启动链路不输出预期语法提示或原生大包误报',
  async (target) => {
    const directory = await mkdtemp(join(tmpdir(), 'weq-web-cli-budget-'));
    try {
      const result = spawnSync(
        process.execPath,
        target === 'cli'
          ? [resolve(__dirname, '../../web/node_modules/vite/bin/vite.js'), 'build']
          : [
              '--input-type=module',
              '-e',
              `
          const {config}=await (await import('electron-vite')).loadConfigFromFile({command:'serve',mode:'development'});
          const plugin=config.main.plugins.find(p=>p?.name==='weq-remote-web-assets');
          await plugin.buildStart();
        `,
            ],
        {
          cwd: target === 'cli' ? resolve(__dirname, '../../web') : resolve(__dirname, '..'),
          env: {
            ...process.env,
            NODE_ENV: target === 'cli' ? 'production' : 'development',
            NODE_ENV_ELECTRON_VITE: 'production',
            npm_execpath: process.env.npm_execpath ?? 'pnpm',
            WEQ_DEV_CONSOLE: '1',
            WEQ_LOG_LEVEL: 'info',
            WEQ_WEB_DIST: directory,
          },
          encoding: 'utf8',
          timeout: 60_000,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      const output = result.stdout + result.stderr;
      expect(result.error).toBeUndefined();
      expect(result.status, output).toBe(0);
      expect(output).toContain('内置 Web 构建完成');
      expect(output).not.toContain('按需语法资源');
      expect(output).not.toContain('Some chunks are larger');
      expect(output).not.toContain('部分构建块压缩后超过');
      expect(output).not.toContain('构建块超出体积预算');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  70_000,
);
