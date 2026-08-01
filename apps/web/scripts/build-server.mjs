/**
 * Bundle the server into `dist/server.mjs` (plus its two sidecar workers).
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
const desktopMain = join(repoRoot, 'apps/desktop/src/main');

const NATIVE_SRC = join(repoRoot, 'native');
const RESOURCES_SRC = join(repoRoot, 'resources');

/** Minimum Node major the launchers accept — matches the esbuild `target`. */
const NODE_MIN_MAJOR = 22;

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

/**
 * Entries that must stay SEPARATE files on disk, because the server spawns them
 * by path rather than importing them:
 *   - injectWorker    — run as a pkexec child (linux, unprivileged host only)
 *   - transcribeWorker — `fork`ed so a sherpa-onnx SIGSEGV can't take the server
 *                        down with it
 * Both are `.mjs` so Node loads them as ESM regardless of the nearest
 * package.json. `inject_elevation.ts` / `transcribe/engine.ts` look for these
 * exact names next to the main bundle.
 */
const ENTRIES = {
  server: join(appRoot, 'src/server/index.ts'),
  injectWorker: join(desktopMain, 'inject_worker.ts'),
  transcribeWorker: join(desktopMain, 'transcribe/worker.ts'),
};

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: [...Object.keys(NATIVE_DEPS), 'sherpa-onnx-node', '*.node'],
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
};

for (const [name, entry] of Object.entries(ENTRIES)) {
  await build({ ...shared, entryPoints: [entry], outfile: join(dist, `${name}.mjs`) });
}

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

writeLaunchers();

writeFileSync(
  join(dist, 'README.txt'),
  [
    'WeQ Web — 浏览器版',
    '',
    '需要 Node.js 22 或更高版本（不内置）。',
    '',
    '启动：',
    '  Windows：双击 start.bat',
    '  Linux  ：./start.sh',
    '',
    '（依赖已随包预装。若自行删了 node_modules，跑 npm install --omit=dev 补回。）',
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
    'Linux 建议直接用 root 运行：注入 QQ 进程需要 ptrace 权限，非 root 时会',
    '改走 pkexec 提权，而无图形界面的服务器弹不出授权框。',
    '',
    'native/ 同时包含 win32-x64 / linux-x64 / linux-arm64 三份原生模块，',
    '运行时按当前平台自动选择，因此同一个压缩包三平台通用。',
    '',
    '完整说明： https://github.com/H3CoF6/WeQ/blob/main/apps/web/README.md',
  ].join('\n'),
);

/**
 * Emit the two launchers. They exist so a user can double-click / `./start.sh`
 * instead of remembering the `node` invocation — and, more usefully, so a
 * missing or too-old Node fails with an actionable message rather than
 * "command not found" or a syntax error from inside the bundle.
 */
function writeLaunchers() {
  writeFileSync(
    join(dist, 'start.bat'),
    [
      '@echo off',
      'setlocal',
      'cd /d "%~dp0"',
      '',
      'where node >nul 2>nul',
      'if errorlevel 1 (',
      '  echo.',
      '  echo   没有找到 Node.js。',
      '  echo   请先安装 Node.js 22 或更高版本： https://nodejs.org/',
      '  echo.',
      '  pause',
      '  exit /b 1',
      ')',
      '',
      'rem 取主版本号（v22.16.0 -> 22）并要求 >= 22。',
      `for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODE_MAJOR=%%v`,
      `if %NODE_MAJOR% LSS ${NODE_MIN_MAJOR} (`,
      '  echo.',
      '  echo   Node.js 版本过低（当前 v%NODE_MAJOR%），需要 22 或更高。',
      '  echo   请到 https://nodejs.org/ 升级。',
      '  echo.',
      '  pause',
      '  exit /b 1',
      ')',
      '',
      'if not exist "node_modules" (',
      '  echo 正在安装依赖...',
      '  call npm install --omit=dev --no-audit --no-fund || exit /b 1',
      ')',
      '',
      'node server.mjs %*',
      'pause',
      '',
    ].join('\r\n'),
  );

  writeFileSync(
    join(dist, 'start.sh'),
    [
      '#!/bin/sh',
      'set -e',
      'cd "$(dirname "$0")"',
      '',
      'if ! command -v node >/dev/null 2>&1; then',
      '  echo',
      '  echo "  没有找到 Node.js。"',
      '  echo "  请先安装 Node.js 22 或更高版本："',
      '  echo "    Debian/Ubuntu:  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs"',
      '  echo "    其它发行版:      https://nodejs.org/"',
      '  echo',
      '  exit 1',
      'fi',
      '',
      '# 主版本号（v22.16.0 -> 22）。',
      'NODE_MAJOR=$(node -p "process.versions.node.split(\'.\')[0]")',
      `if [ "$NODE_MAJOR" -lt ${NODE_MIN_MAJOR} ]; then`,
      '  echo',
      '  echo "  Node.js 版本过低（当前 v$NODE_MAJOR），需要 22 或更高。"',
      '  echo "  升级方式见 https://nodejs.org/"',
      '  echo',
      '  exit 1',
      'fi',
      '',
      '# 注入 QQ 进程要 ptrace 权限。非 root 时会退回 pkexec 提权，而无图形',
      '# 会话的服务器根本弹不出授权框，所以这里提前提示。',
      'if [ "$(id -u)" -ne 0 ]; then',
      '  echo',
      '  echo "  提示：当前不是 root。获取密钥需要注入 QQ 进程（ptrace），"',
      '  echo "        非 root 会改走 pkexec 图形授权，无桌面环境时会失败。"',
      '  echo "        建议改用：sudo ./start.sh"',
      '  echo',
      'fi',
      '',
      'if [ ! -d node_modules ]; then',
      '  echo "正在安装依赖..."',
      '  npm install --omit=dev --no-audit --no-fund',
      'fi',
      '',
      'exec node server.mjs "$@"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
}

console.log(`\n  built → ${dist}`);
console.log('  contents: server.mjs + workers + public/ + native/ + resources/ + start.sh/bat\n');
