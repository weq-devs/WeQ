/**
 * 拉取 / 校验 nt_helper 原生产物（5 个平台的 `nt_helper.node` + 装扮离线资源 `*.dat`）。
 *
 * 这两类文件**不再入库**：仓库里只留加载器与布局约定，二进制由 native 私仓
 * `H3CoF6/nt_helper` 构建后发布到公开仓 `H3CoF6/nt_helper_release`，这里按需取回。
 *
 * 为什么必须「成对取」：装扮资源 `.dat` 的 AES key 由构建 commit 派生
 * （nt_helper 的 `build.rs`，CI 传 `DRESS_KEY_SEED=github.sha`）并烘焙进 `.node`，
 * 跨版本混用会直接解不开。脚本因此永远从同一个 release tag 里取 `.node` 与 `.dat`。
 *
 * **默认不是 latest，而是 `native/pinned.json` 里锚定的那个 tag**：WeQ 的代码是照着
 * 某一份 native 构建写的（类型、能力、装扮资源的密钥都由它决定），跟着 latest 漂会
 * 在"WeQ 已经用到新字段、而本地那份还是旧的"这类情况下静默降级。锚文件是这个仓库里
 * 唯一一处"我们认哪一份 native"的记录，升级它是一次显式提交（见 --write-pin）。
 *
 * 为什么还要 latest：CI 构建出的 `.node` 带 30 天有效期（`BUILD_TIMESTAMP`，由
 * `getInitStatus()` 判定），拿过期包打出来的安装包起不来。所以发布时间到了就得换一份
 * 新的：升级流程 = `--latest --verify` 验证新构建 → `--latest --write-pin` 写回锚点 →
 * 提交锚文件。`--check` 会提醒锚点已经落后于上游，`--require-fresh` 则在 CI 上把过期
 * 构建直接挡在打包之前。
 *
 * 用法：
 *   pnpm native:fetch                      # 本机平台 + 装扮资源（锚定的 tag）
 *   pnpm native:fetch --all                # 五个平台全量 + 装扮资源
 *   pnpm native:fetch --platform linux-arm64
 *   pnpm native:fetch --latest             # 忽略锚点，取上游最新（试用新构建用）
 *   pnpm native:fetch --version nt-helper-20260916-86cb5a4
 *   pnpm native:fetch --latest --write-pin # 把这次取到的 tag 写回锚文件（升级锚点）
 *   pnpm native:fetch --dress-only         # 只补装扮资源
 *   pnpm native:fetch --no-dress           # 只要 .node
 *   pnpm native:fetch --check              # 只比对，不改文件（缺失 / 落后 / 过期 → 退出码 1）
 *   pnpm native:fetch --require-fresh      # CI 用：超过 --max-age（默认 25）天直接失败
 *   pnpm native:fetch --verify             # 装完在宿主机 require 一次并跑 getInitStatus()
 *   pnpm native:fetch --from-dir ./dist    # 从本地目录装（需含 manifest.json + 各资产；离线 / 镜像）
 *   pnpm native:fetch --dry-run            # 只打印将要写入的文件
 *
 * 环境变量：
 *   NT_HELPER_RELEASE_REPO      发布仓，默认 H3CoF6/nt_helper_release
 *   NT_HELPER_RELEASE_BASE_URL  下载前缀（镜像 / 代理），默认 GitHub Releases
 *   NT_HELPER_VERSION           钉死 tag（等价于 --version；CI 里临时试构建用）
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

// ─────────────────────────── 常量 ───────────────────────────

/** 默认发布仓：私仓构建后把产物推到这里，WeQ（公开）与 dev 都从这里取。 */
const DEFAULT_REPO = 'H3CoF6/nt_helper_release';
/** 每个平台的目标目录与资产名，与 nt_helper 的 rust-release.yml 约定一致。 */
const PLATFORMS = {
  'win32-x64': { dir: 'native/win32/x64', asset: 'nt_helper-win32-x64.node' },
  'linux-x64': { dir: 'native/linux/x64', asset: 'nt_helper-linux-x64.node' },
  'linux-arm64': { dir: 'native/linux/arm64', asset: 'nt_helper-linux-arm64.node' },
  'darwin-x64': { dir: 'native/darwin/x64', asset: 'nt_helper-darwin-x64.node' },
  'darwin-arm64': { dir: 'native/darwin/arm64', asset: 'nt_helper-darwin-arm64.node' },
};
/** 装扮资源三件套（平台无关，同一份给五个平台用）。 */
const DRESS_PARTS = ['bubble', 'widget', 'font'];
const DRESS_DIR = join('resources', 'dress');
/** 装了哪个 tag / 哪些文件，供 --check 比对；.gitignore 掉了。 */
const MARKER = join('native', '.installed.json');
/**
 * **入库的版本锚**：这个仓库认哪一份 native 构建。
 *
 * 只有 `tag`（外加一份给人看的 `commit` / `note`）—— 校验靠那个 tag 的 `manifest.json`
 * 里的 sha256，不在这里抄一份哈希（抄了就会和发布仓的实际内容打架）。
 */
const PIN = join('native', 'pinned.json');
/** `.installed.json` / `pinned.json` 都缺 `note` 时的默认说明。 */
const DEFAULT_PIN_NOTE =
  'WeQ 的代码锚定在这份 native 构建上。升级：pnpm native:fetch --latest --verify → ' +
  'pnpm native:fetch --latest --write-pin → 提交本文件。';

/** nt_helper 的硬约束：.node 构建满 30 天即失效。 */
const HARD_MAX_AGE_DAYS = 30;
/** --require-fresh 默认卡在 25 天，留 5 天余量。 */
const DEFAULT_MAX_AGE_DAYS = 25;
/** 超过这个天数就提醒（不失败）。 */
const WARN_AGE_DAYS = 21;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ─────────────────────────── 参数 ───────────────────────────

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const opt = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (has('--help') || has('-h')) {
  const self = await readFile(fileURLToPath(import.meta.url), 'utf8');
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

const checkOnly = has('--check');
const dryRun = has('--dry-run');
const doVerify = has('--verify');
const dressOnly = has('--dress-only');
const withDress = !has('--no-dress');
const requireFresh = has('--require-fresh');
const wantLatest = has('--latest');
const writePin = has('--write-pin');
const explicitVersion = opt('--version') ?? process.env.NT_HELPER_VERSION;
const fromDirArg = opt('--from-dir');
const fromDir = fromDirArg ? resolve(fromDirArg) : undefined;
const root = opt('--root') ? resolve(opt('--root')) : repoRoot;
const maxAgeDays = Number(opt('--max-age') ?? DEFAULT_MAX_AGE_DAYS);

const releaseRepo = process.env.NT_HELPER_RELEASE_REPO ?? DEFAULT_REPO;
const baseUrl = (
  process.env.NT_HELPER_RELEASE_BASE_URL ?? `https://github.com/${releaseRepo}/releases`
).replace(/\/+$/, '');

const hostTag = `${process.platform}-${process.arch}`;

/**
 * 读版本锚（`native/pinned.json`）。
 *
 * 缺文件 / 坏 JSON 都不致命：返回 `undefined`，调用方回落到 latest 并**大声提醒** ——
 * 静默按 latest 走正是这个锚要解决的问题。
 */
async function readPin() {
  const file = join(root, PIN);
  if (!existsSync(file)) return undefined;
  try {
    const pin = JSON.parse(await readFile(file, 'utf8'));
    return typeof pin?.tag === 'string' && pin.tag.length > 0 ? pin : undefined;
  } catch (err) {
    log(`⚠ 读不了版本锚 ${PIN}（${err instanceof Error ? err.message : err}），这次按 latest 走`);
    return undefined;
  }
}

/** 要装哪些平台：--all 全量；--platform 指定（逗号分隔）；否则宿主平台。 */
function selectedPlatforms() {
  if (dressOnly) return [];
  if (has('--all')) return Object.keys(PLATFORMS);
  const raw = opt('--platform');
  const wanted = (raw ? raw.split(',') : [hostTag]).map((name) => name.trim()).filter(Boolean);
  for (const name of wanted) {
    if (!PLATFORMS[name]) {
      throw new Error(
        `不认识的平台 ${name}；可用：${Object.keys(PLATFORMS).join(' / ')}（宿主是 ${hostTag}）`,
      );
    }
  }
  return wanted;
}

// ─────────────────────────── 小工具 ───────────────────────────

const log = (...args) => {
  if (!has('--quiet')) console.log(...args);
};

const mb = (bytes) => `${(Number(bytes) / 1024 / 1024).toFixed(1)} MB`;

async function sha256File(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

function ageDays(iso) {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? Number.NaN : (Date.now() - at) / 86400_000;
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`下载失败 ${res.status} ${res.statusText}：${url}`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

// ─────────────────────────── manifest ───────────────────────────

/**
 * 读远端（或 `--from-dir` 的本地）manifest。
 *
 * 结构由 nt_helper 的 publish-release job 生成：
 *   {
 *     tag: 'nt-helper-20260916-86cb5a4',
 *     commit: '<nt_helper commit sha>',
 *     builtAt: '<ISO8601>',
 *     platforms: { 'linux-x64': { asset, sha256, size }, … },
 *     dress:     { bubble: { asset, sha256, size }, widget: { … }, font: { … } },
 *   }
 */
async function loadManifest(version) {
  if (fromDir) {
    const file = join(fromDir, 'manifest.json');
    if (!existsSync(file)) throw new Error(`--from-dir 里没有 manifest.json：${file}`);
    return { manifest: JSON.parse(await readFile(file, 'utf8')), localDir: fromDir };
  }
  const url = manifestUrl(version);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(
      `拿不到 manifest（${res.status} ${res.statusText}）：${url}\n` +
        (version === 'latest'
          ? '发布仓还没有产物？先去 nt_helper 跑一次 Rust-Release-Build 工作流。'
          : `这个 tag 是${PIN} 里锚定的那个：发布仓里没有它？把锚点改成实际存在的 tag（或用 --latest）。`),
    );
  }
  return { manifest: await res.json(), localDir: undefined };
}

function manifestUrl(version) {
  return version === 'latest'
    ? `${baseUrl}/latest/download/manifest.json`
    : `${baseUrl}/download/${encodeURIComponent(version)}/manifest.json`;
}

/** 上游 latest 的 tag；拿不到（离线 / 限流）就返回 `undefined`。 */
async function fetchLatestTag() {
  try {
    const res = await fetch(manifestUrl('latest'), { redirect: 'follow' });
    if (!res.ok) return undefined;
    const manifest = await res.json();
    return typeof manifest?.tag === 'string' ? manifest.tag : undefined;
  } catch {
    return undefined;
  }
}

/** 把当前取值写回版本锚（升级锚点用；`note` 原样保留）。 */
async function writePinFile(manifest, previous) {
  const dest = join(root, PIN);
  const pin = {
    tag: manifest.tag,
    ...(manifest.commit ? { commit: manifest.commit } : {}),
    pinnedAt: new Date().toISOString().slice(0, 10),
    note:
      typeof previous?.note === 'string' && previous.note.length > 0
        ? previous.note
        : DEFAULT_PIN_NOTE,
  };
  await writeFile(dest, `${JSON.stringify(pin, null, 2)}\n`);
  log(`锚点已写入 ${PIN}：${pin.tag}`);
}

/** manifest → 本次要落盘的文件清单。 */
function planFiles(manifest, platforms) {
  const files = [];
  for (const name of platforms) {
    const spec = PLATFORMS[name];
    const meta = manifest.platforms?.[name];
    if (!meta) throw new Error(`manifest（tag=${manifest.tag}）里没有平台 ${name}`);
    files.push({
      label: name,
      path: join(spec.dir, 'nt_helper.node'),
      asset: meta.asset ?? spec.asset,
      sha256: meta.sha256,
      size: meta.size,
    });
  }
  if (withDress) {
    for (const part of DRESS_PARTS) {
      const meta = manifest.dress?.[part];
      if (!meta) throw new Error(`manifest（tag=${manifest.tag}）里没有装扮资源 ${part}`);
      files.push({
        label: `dress/${part}`,
        path: join(DRESS_DIR, `${part}.dat`),
        asset: meta.asset ?? `dress-${part}.dat`,
        sha256: meta.sha256,
        size: meta.size,
      });
    }
  }
  return files;
}

// ─────────────────────────── 安装 ───────────────────────────

async function install(manifest, files, localDir) {
  const staging = await mkdtemp(join(tmpdir(), 'weq-native-'));
  try {
    for (const entry of files) {
      if (dryRun) {
        log(`  [dry-run] ${entry.label.padEnd(16)} → ${entry.path} (${mb(entry.size)})`);
        continue;
      }

      const staged = join(staging, entry.asset);
      if (localDir) {
        const source = join(localDir, entry.asset);
        if (!existsSync(source)) throw new Error(`本地缺资产：${source}`);
        await copyFile(source, staged);
      } else {
        await download(`${baseUrl}/download/${manifest.tag}/${entry.asset}`, staged);
      }

      if (entry.sha256) {
        const got = await sha256File(staged);
        if (got !== entry.sha256) {
          throw new Error(
            `${entry.asset} sha256 不匹配（期望 ${entry.sha256}，实际 ${got}）；已中止，本地文件未改动`,
          );
        }
      }

      // 先在同目录落到临时名再 rename：中途失败不会留下半个二进制。
      const dest = join(root, entry.path);
      await mkdir(dirname(dest), { recursive: true });
      const incoming = `${dest}.incoming-${process.pid}`;
      await copyFile(staged, incoming);
      await chmod(incoming, 0o644);
      await rename(incoming, dest);
      log(`  ${entry.label.padEnd(16)} → ${entry.path} (${mb(entry.size)})`);
    }

    if (!dryRun) await writeMarker(manifest, files);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function writeMarker(manifest, files) {
  // 同 tag 的多次 fetch（比如后来只补了 --dress-only）要合并，不能把之前的条目冲掉，
  // 否则 --check 会漏检这批文件。换 tag 说明整份换新，旧的条目直接丢掉。
  const previous = await readMarker();
  const merged = new Map();
  if (previous?.tag === manifest.tag) {
    for (const entry of previous.files ?? []) merged.set(entry.path, entry);
  }
  for (const entry of files) {
    merged.set(entry.path, { path: entry.path, sha256: entry.sha256 });
  }

  const marker = {
    tag: manifest.tag,
    commit: manifest.commit,
    builtAt: manifest.builtAt,
    fetchedAt: new Date().toISOString(),
    files: [...merged.values()],
  };
  const dest = join(root, MARKER);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, `${JSON.stringify(marker, null, 2)}\n`);
}

async function readMarker() {
  const file = join(root, MARKER);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

// ─────────────────────────── 校验 ───────────────────────────

async function check(manifest, pin) {
  const age = ageDays(manifest.builtAt);
  const ageText = Number.isNaN(age) ? '未知' : `${age.toFixed(1)} 天`;
  log(
    `远端：${manifest.tag}（commit ${String(manifest.commit ?? '').slice(0, 7)}，${ageText}前构建）`,
  );

  const marker = await readMarker();
  if (!marker) {
    console.error('本地没装过（没有 native/.installed.json）→ 跑 `pnpm native:fetch`');
    return 1;
  }

  const problems = [];
  if (pin && pin.tag !== manifest.tag) {
    problems.push(`版本锚 ${PIN} 锚定 ${pin.tag}，与本次比对的 ${manifest.tag} 不一致`);
  }
  if (!pin) problems.push(`缺版本锚 ${PIN}（跑一次 pnpm native:fetch --write-pin 生成）`);
  if (marker.tag !== manifest.tag) problems.push(`落后：本地 ${marker.tag}，远端 ${manifest.tag}`);
  const hostAddon = PLATFORMS[hostTag] ? join(PLATFORMS[hostTag].dir, 'nt_helper.node') : undefined;
  if (hostAddon && !(marker.files ?? []).some((entry) => entry.path === hostAddon)) {
    problems.push(`本机平台的 .node 没装：${hostAddon}（跑 pnpm native:fetch）`);
  }
  for (const entry of marker.files ?? []) {
    const file = join(root, entry.path);
    if (!existsSync(file)) {
      problems.push(`缺文件：${entry.path}`);
    } else if (entry.sha256 && (await sha256File(file)) !== entry.sha256) {
      problems.push(`内容对不上（被改过？）：${entry.path}`);
    }
  }
  if (Number.isNaN(age) || age > HARD_MAX_AGE_DAYS) {
    problems.push(`远端构建已过期（${ageText} > ${HARD_MAX_AGE_DAYS} 天），装上也用不了`);
  }

  if (problems.length === 0) {
    log(`本地：${marker.tag} ✔ 一致（${marker.files?.length ?? 0} 个文件）`);
    if (age > WARN_AGE_DAYS) {
      log(`提醒：这份构建还有约 ${(HARD_MAX_AGE_DAYS - age).toFixed(1)} 天到期，建议重新 fetch`);
    }
    const latestTag = await fetchLatestTag();
    if (latestTag && latestTag !== manifest.tag) {
      log(
        `提醒：上游有更新的构建 ${latestTag}（本地锚定 ${manifest.tag}）。` +
          '试用：pnpm native:fetch --latest --verify；确认无误后 pnpm native:fetch --latest --write-pin 并提交锚文件。',
      );
    }
    return 0;
  }
  for (const problem of problems) console.error(`✘ ${problem}`);
  return 1;
}

/**
 * 在宿主机 require 一次刚装好的 .node，跑 `getInitStatus()`。
 *
 * 这是唯一能提前发现「二进制装上了但用不了」（构建过期 / LICENSE 不匹配 /
 * 平台错配）的检查，release 流程拿它当门禁。
 */
async function verifyHost(files) {
  const spec = PLATFORMS[hostTag];
  if (!spec || !files.some((entry) => entry.path.startsWith(spec.dir))) {
    log(`跳过 --verify：本次没装宿主平台（${hostTag}）的 .node`);
    return 0;
  }
  const addon = join(root, spec.dir, 'nt_helper.node');
  const require = createRequire(import.meta.url);
  let status;
  try {
    const mod = require(addon);
    status = await mod.getInitStatus?.();
  } catch (err) {
    console.error(`✘ require/调用失败：${err instanceof Error ? err.message : err}`);
    return 1;
  }
  if (status !== 0) {
    console.error(
      `✘ getInitStatus() = ${status}（0 才是可用；-1 过期 / -200 损坏 / -201 被篡改 / 99 未知）`,
    );
    return 1;
  }
  log(`--verify ✔ ${spec.dir}/nt_helper.node 可用（getInitStatus() = 0）`);
  return 0;
}

// ─────────────────────────── 主流程 ───────────────────────────

async function main() {
  const platforms = selectedPlatforms();
  if (platforms.length === 0 && !withDress) {
    throw new Error('没有任何要装的目标（--dress-only 不能和 --no-dress 一起用）');
  }

  if (explicitVersion && wantLatest) {
    throw new Error('--version 与 --latest 不能一起用：指定了 tag 就已经不是"取最新"的意思了');
  }

  const pin = await readPin();
  const version = explicitVersion ?? (wantLatest ? 'latest' : (pin?.tag ?? 'latest'));
  if (explicitVersion) log(`版本：${version}（--version / NT_HELPER_VERSION 指定）`);
  else if (wantLatest) log(`版本：latest（--latest，忽略 ${PIN}）`);
  else if (pin) log(`版本：${version}（锚定于 ${PIN}）`);
  else log(`⚠ 没有 ${PIN}，这次按 latest 取；建议锚一份，避免代码与 native 悄悄漂开`);

  const { manifest, localDir } = await loadManifest(version);
  if (!manifest?.tag) throw new Error('manifest 里没有 tag 字段，发布仓格式不对？');

  const age = ageDays(manifest.builtAt);
  if (requireFresh && !Number.isNaN(age) && age > maxAgeDays) {
    throw new Error(
      `最新构建也过期了（${age.toFixed(1)} 天 > ${maxAgeDays} 天）——` +
        '先去 nt_helper 跑一次 Rust-Release-Build 再发版。',
    );
  }

  if (checkOnly) return check(manifest, pin);

  const files = planFiles(manifest, platforms);
  log(`来源：${localDir ?? `${releaseRepo}@${manifest.tag}`}`);
  log(`写入：${root}`);
  await install(manifest, files, localDir);
  if (writePin && !dryRun) await writePinFile(manifest, pin);

  if (!dryRun && (Number.isNaN(age) || age > WARN_AGE_DAYS)) {
    log(
      `提醒：这份构建是 ${Number.isNaN(age) ? '未知' : age.toFixed(1)} 天前编的，满 ${HARD_MAX_AGE_DAYS} 天会失效`,
    );
  }
  return doVerify && !dryRun ? verifyHost(files) : 0;
}

try {
  process.exitCode = await main();
} catch (err) {
  console.error(`✘ ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
}
