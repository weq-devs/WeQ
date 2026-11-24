#!/usr/bin/env node
/**
 * 构建 WeqBot daemon 的单文件产物，给 WeQ 打包用。
 *
 * 为什么由 WeQ 自己构建而不是「装一个 weqbot 发布包」：
 *
 *   - 产物必须和 WeQ **共用同一份 native**（`native/<platform>/<arch>/nt_helper.node`）。
 *     两套安装各自带一份 `.node` 会让 `subAppId` / 版本慢慢漂移，而那个字段写错
 *     会让服务端静默丢弃注册。
 *   - 入口里不能出现 `.node`：loader 按 `WEQBOT_NATIVE_DIR` 指向的路径加载。
 *
 * 产物位置：`resources/weqbot/weqbot-daemon.mjs`。
 * 它跟着 `resources/**` 的 extraResources 一起进安装包（见 electron-builder.yml），
 * 与 AI 克隆体用的 `resources/bot-runtime/` 分开 —— 那是另一个东西。
 *
 * 参数：
 *   node scripts/build-weqbot-daemon.mjs [--out <dir>]
 * 环境变量：WEQBOT_DAEMON_OUT
 */

import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendorRoot = join(root, 'vendor', 'weqbot');

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export async function buildWeqbotDaemon(
  outfile = resolve(root, 'resources', 'weqbot', 'weqbot-daemon.mjs'),
) {
  await mkdir(dirname(outfile), { recursive: true });
  await build({
    absWorkingDir: vendorRoot,
    entryPoints: [join(vendorRoot, 'packages', 'node', 'src', 'daemon-entry.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    legalComments: 'none',
    logLevel: 'warning',
    // 依赖里还有 CJS（ws）：ESM 输出里没有 `require`，用 createRequire 补上，
    // 否则 CJS 模块内部的 `require('events')` 会在启动时就抛错。
    banner: {
      js: "import { createRequire as __weqbotCreateRequire } from 'node:module'; const require = __weqbotCreateRequire(import.meta.url);",
    },
  });
  const { size } = await stat(outfile);
  return { outfile, size };
}

/**
 * 产物自检。
 *
 * 这里**不能**要求「没有 createRequire / .node 字样」—— daemon 的 loader 本来
 * 就要按路径加载 `.node`（WeqBot 的 `check-pure-ts` 也只允许 `@weqbot/node` 这么
 * 做）。真正要守的是两件事：
 *
 *   1. **没有内联二进制**：产物是纯文本 JS，体积不应该接近 native 大小；
 *   2. **没有写死 WeQ 的安装路径**：native 必须由 `WEQBOT_NATIVE_DIR` 指过来，
 *      否则换台机器就找不到。
 */
export async function assertNoNativeBinary(outfile) {
  const text = await readFile(outfile, 'utf8');
  if (/process\.dlopen/.test(text)) {
    throw new Error(`产物里出现了 process.dlopen：${outfile}`);
  }
  // 安装根的绝对路径（`/opt/WeQ`、`C:\\Program Files\\WeQ` 之类）不能被烘进产物。
  if (/resourcesPath\s*\+\s*['"][^'"]*native/.test(text)) {
    throw new Error(`产物里把 WeQ 的 resourcesPath 拼成了 native 路径：${outfile}`);
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const out = option('--out') ?? process.env.WEQBOT_DAEMON_OUT;
  const result = await buildWeqbotDaemon(out ? resolve(out) : undefined);
  await assertNoNativeBinary(result.outfile);
  process.stdout.write(
    `[weqbot-daemon] ${(result.size / 1024 / 1024).toFixed(1)} MB → ${result.outfile.replace(`${root}/`, '')}\n`,
  );
}
