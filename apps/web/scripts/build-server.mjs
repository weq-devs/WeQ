/**
 * Bundle the server into a single `dist/server.mjs`.
 *
 * Universal by design: `native/` ships all platform/arch subtrees and
 * `@weq/native`'s loader picks `native/<process.platform>/<process.arch>` at
 * runtime, so one archive runs on win32-x64, linux-x64 and linux-arm64.
 *
 * `.node` addons stay external — esbuild can't inline them, and they don't need
 * rebuilding anyway (both are N-API, so the same binary loads under plain Node
 * and under Electron).
 */

import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const repoRoot = resolve(appRoot, '../..');
const dist = join(appRoot, 'dist');

const NATIVE_SRC = join(repoRoot, 'native');
const RESOURCES_SRC = join(repoRoot, 'resources');

// `scripts/set-version.mjs` stamps this from the release tag; baked in so the
// running server can report its own version without reading package.json.
const { version } = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'));

/**
 * Packages that load native `.node` bindings. esbuild can't inline those, so
 * they stay external and ship as real `node_modules` alongside the bundle.
 */
const NATIVE_DEPS = {
  ws: '^8.18.0',
  '@resvg/resvg-js': '^2.6.2',
};

await build({
  entryPoints: [join(appRoot, 'src/server/index.ts')],
  outfile: join(dist, 'server.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: [...Object.keys(NATIVE_DEPS), '*.node'],
  banner: {
    // Bundled CJS deps reach for CJS globals that don't exist in an ESM bundle.
    //   - `require`: esbuild's dynamic-require stub checks `typeof require` and
    //     defers to it when defined, so defining it here turns "Dynamic require
    //     of crypto is not supported" (exceljs) into a working call.
    //   - `__filename`/`__dirname`: provided under mangled names + `define`d,
    //     because bundled chunks already declare their own `__dirname` and a
    //     direct declaration would collide.
    js: [
      "import { createRequire as __weqCreateRequire } from 'node:module';",
      "import { fileURLToPath as __weqFromFileUrl } from 'node:url';",
      "import { dirname as __weqDirname } from 'node:path';",
      'const require = __weqCreateRequire(import.meta.url);',
      'const __weqFilename = __weqFromFileUrl(import.meta.url);',
      'const __weqDirnameValue = __weqDirname(__weqFilename);',
    ].join('\n'),
  },
  define: {
    __filename: '__weqFilename',
    __dirname: '__weqDirnameValue',
    __WEQ_VERSION__: JSON.stringify(version),
  },
  logLevel: 'info',
});

// native/ — every platform, so one archive covers them all.
if (!existsSync(NATIVE_SRC)) {
  console.error(`\nnative/ not found at ${NATIVE_SRC} — the build would not run.`);
  process.exit(1);
}
rmSync(join(dist, 'native'), { recursive: true, force: true });
cpSync(NATIVE_SRC, join(dist, 'native'), { recursive: true });

// resources/ — brand assets etc. read at runtime.
if (existsSync(RESOURCES_SRC)) {
  rmSync(join(dist, 'resources'), { recursive: true, force: true });
  cpSync(RESOURCES_SRC, join(dist, 'resources'), { recursive: true });
}

// A manifest so `node server.mjs` resolves `ws` without a full install.
mkdirSync(dist, { recursive: true });
writeFileSync(
  join(dist, 'package.json'),
  `${JSON.stringify({ name: 'weq-web', private: true, type: 'module', dependencies: NATIVE_DEPS }, null, 2)}\n`,
);

writeFileSync(
  join(dist, 'README.txt'),
  [
    'WeQ Web — 浏览器版',
    '',
    '需要 Node.js 22 或更高版本（不内置）。',
    '',
    '启动：',
    '  npm install --omit=dev     # 装 3 个依赖',
    '  node server.mjs',
    '',
    '然后浏览器打开终端里打印的地址，用同时打印的访问令牌登录。',
    '',
    '环境变量：',
    '  WEQ_TOKEN       访问令牌。绑定到非本机地址时必须显式设置。',
    '  WEQ_HOST        监听地址，默认 127.0.0.1。设为 0.0.0.0 才对外可见。',
    '  WEQ_PORT        端口，默认 7690；被占用时自动向后探测。',
    '  WEQ_EXPORT_DIR  导出目录，默认 ./weq-exports',
    '  WEQ_DATA_DIR    日志目录，默认 ./weq-data',
    '',
    '⚠ 对外暴露前请务必放在 HTTPS 反向代理之后，并设置一个足够长的 WEQ_TOKEN。',
    '   这个服务能读取该机器上 QQ 的全部本地聊天记录。',
    '',
    'native/ 同时包含 win32-x64 / linux-x64 / linux-arm64 三份原生模块，',
    '运行时按当前平台自动选择，因此同一个压缩包三平台通用。',
    '',
    '完整说明： https://github.com/H3CoF6/WeQ/blob/main/apps/web/README.md',
  ].join('\n'),
);

console.log(`\n  built → ${dist}`);
console.log('  contents: server.mjs + public/ + native/ + resources/\n');
