#!/usr/bin/env node
/**
 * CI 本地一键跑 —— 把 `.github/workflows/ci.yml` 的门禁在本地按同样顺序复刻一遍，
 * 提交 / 开 PR 之前跑一次，就不用等 CI 跑完才发现挂了。
 *
 * 默认覆盖 CI 的快检查门禁（lint / format / typecheck / test / daemon），
 * 边跑边打印每一步的命令；**不 fail-fast**：某一步红了也继续往下跑，最后给一张
 * 汇总表，省得来回「跑一次 → 修一个 → 再跑一次」。
 *
 * 用法：
 *   pnpm ci:local                 # 快速门禁（默认）
 *   pnpm ci:local --fix           # 先 pnpm format / lint:fix 刷平，再跑门禁
 *   pnpm ci:local --full          # 额外跑 web 打包冒烟（≈ CI 的 build-web job）
 *   pnpm ci:local --no-daemon     # 跳过 cargo 三项（本机没装 Rust 时用）
 *   pnpm ci:local --fail-fast     # 任一步失败即停
 *   pnpm ci:local --list          # 只打印将要跑的步骤，不执行
 *
 * 注：CI 的 `build-linux` job 已移除 —— 打包链路由 release 流水线兜底，本地
 * 用 `pnpm --filter @weq/desktop build:unpack` 单独验即可，不塞进这个快检查里。
 */

import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);

if (has('--help') || has('-h')) {
  const self = await import('node:fs').then((fs) =>
    fs.readFileSync(fileURLToPath(import.meta.url), 'utf8'),
  );
  const doc = self.slice(self.indexOf('/**') + 3, self.indexOf('*/'));
  console.log(
    doc
      .split('\n')
      .map((line) => line.replace(/^ \* ?/, ''))
      .join('\n')
      .trim(),
  );
  process.exit(0);
}

const FIX = has('--fix');
const FULL = has('--full') || has('--with-build');
const NO_DAEMON = has('--no-daemon');
const FAIL_FAST = has('--fail-fast');
const LIST_ONLY = has('--list');

const daemonDir = join(repoRoot, 'packages', 'daemon');

/** 装没装 cargo —— 没装就把 daemon 三项降级成跳过（而不是直接红）。 */
const hasCargo = spawnSync('cargo', ['--version'], { stdio: 'ignore', shell: true }).status === 0;
const skipDaemon = NO_DAEMON || !hasCargo;

/** 一条门禁步骤。`cwd` 省略即仓库根。 */
function step(name, cmd, cwd) {
  return { name, cmd, cwd };
}

const steps = [
  step('Biome lint', 'pnpm lint'),
  step('Biome 格式检查', 'pnpm format:check'),
  step('TypeScript 类型检查 (pnpm -r typecheck)', 'pnpm -r typecheck'),
  step(
    skipDaemon
      ? '非 Rust 工作区单元测试（含 desktop + web）'
      : '单元测试（含 desktop + web + daemon）',
    skipDaemon
      ? "pnpm --filter '!@weq/daemon' -r --workspace-concurrency=2 test --maxWorkers=2 --minWorkers=1"
      : 'pnpm -r test',
  ),
];

if (!NO_DAEMON && hasCargo) {
  steps.push(
    step('Rust 格式检查 (cargo fmt --check)', 'cargo fmt --check', daemonDir),
    step(
      'Rust clippy (-D warnings)',
      'cargo clippy --all-targets --all-features -- -D warnings',
      daemonDir,
    ),
    step('Rust 单测 (cargo test)', 'cargo test', daemonDir),
  );
}

if (FULL) {
  // 对应 CI 的 build-web job：native 产物 + daemon 二进制 + 守卫 + 真实产物冒烟。
  steps.push(
    step('取 nt_helper 原生产物', 'node scripts/fetch-native.mjs --require-fresh --verify'),
    step('构建 daemon 二进制', 'pnpm run build:daemon'),
    step('构建 web 产物 + 守卫', 'pnpm --filter @weq/web build'),
    step('冒烟测试打包后的 server', 'pnpm --filter @weq/web test:dist'),
  );
}

const rel = (p) => (p ? relative(repoRoot, p) || '.' : '.');
const c = (code, s) =>
  process.stdout.isTTY && !process.env.NO_COLOR ? `\u001b[${code}m${s}\u001b[0m` : s;
const bold = (s) => c('1', s);
const green = (s) => c('32', s);
const red = (s) => c('31', s);
const yellow = (s) => c('33', s);
const dim = (s) => c('2', s);

if (LIST_ONLY) {
  console.log(bold(`本地 CI 步骤（共 ${steps.length} 步）`));
  steps.forEach((s, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${s.name}`);
    console.log(dim(`      $ ${s.cmd}  (${rel(s.cwd)})`));
  });
  process.exit(0);
}

console.log(bold('== 本地 CI =='));
if (!FULL) console.log(dim('（快速门禁；加 --full 追加 web 打包冒烟）'));
if (NO_DAEMON || !hasCargo) {
  console.log(yellow(`跳过 Rust 三项：${NO_DAEMON ? '--no-daemon' : '本机没有 cargo'}`));
}

function run(cmd, cwd) {
  const started = Date.now();
  const res = spawnSync(cmd, { cwd: cwd ?? repoRoot, stdio: 'inherit', shell: true });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const ok = res.status === 0;
  return { ok, seconds, status: res.status, signal: res.signal };
}

if (FIX) {
  console.log(bold('\n== 自动修复 =='));
  for (const [name, cmd] of [
    ['Biome 格式化 (写回)', 'pnpm format'],
    ['Biome lint 自动修复 (写回)', 'pnpm lint:fix'],
  ]) {
    console.log(`\n▶ ${name}\n  $ ${cmd}`);
    run(cmd);
  }
}

const results = [];
for (const s of steps) {
  console.log(bold(`\n▶ ${s.name}`));
  console.log(dim(`  $ ${s.cmd}  (${rel(s.cwd)})`));
  const r = run(s.cmd, s.cwd);
  results.push({ ...s, ...r });
  if (!r.ok) {
    console.log(red(`  ✗ 失败（退出码 ${r.status ?? `signal ${r.signal}`}，${r.seconds}s）`));
    if (FAIL_FAST) break;
  } else {
    console.log(green(`  ✓ 通过（${r.seconds}s）`));
  }
}

const failed = results.filter((r) => !r.ok);
const skipped = steps.length - results.length;

console.log(bold('\n== 汇总 =='));
const pad = Math.max(...results.map((r) => r.name.length), 8);
for (const r of results) {
  const mark = r.ok ? green('✓') : red('✗');
  console.log(`  ${mark} ${r.name.padEnd(pad)}  ${dim(`${r.seconds}s`)}`);
}
if (skipped > 0) console.log(yellow(`  ⏭ 因 --fail-fast 跳过 ${skipped} 步`));

if (failed.length === 0) {
  console.log(green(bold(`\n全部通过（${results.length} 步）🎉`)));
  process.exit(0);
}

console.log(red(bold(`\n${failed.length} 步失败：`)));
for (const r of failed) console.log(red(`  • ${r.name}`));
console.log(dim('\n提示：格式问题直接 `pnpm format` 一把刷平；本地 CI 可加 --fix。'));
process.exit(1);
