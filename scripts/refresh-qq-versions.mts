/**
 * 抓 QQ 官网的 PC 版本清单，写 `versions/latest.json`，并把新版本登记到
 * `versions/supported.json` 的「待验证」区。
 *
 * 数据源是官网下载页真正用的那个接口（不是 HTML 解析）：
 *
 *   https://qq-web.cdn-go.cn/im.qq.com_new/latest/rainbow/pcConfig.json
 *
 * 官网 `assets/download.js` 里把它当主 CDN，`im.qq.com/proxy/domain/...` 当备用；
 * 两份返回同一份 JSON。结构（2026-11 实测）：
 *
 * ```json
 * {
 *   "Windows": { "version": "9.9.37", "updateDate": "...",
 *                "ntDownloadX64Url": "...", "ntDownloadARMUrl": "..." },
 *   "Linux":   { "version": "3.2.35",
 *                "x64DownloadUrl": { "deb": "...", "rpm": "...", "appimage": "..." },
 *                "armDownloadUrl": { "deb": "...", ... } },
 *   "macOS":   { "version": "7.0.3 (Intel+Apple Silicon)",
 *                "downloadUrl": ".../QQ_7.0.3_261103_01.dmg" }
 * }
 * ```
 *
 * **只写版本号与下载地址，不下载安装包**：下载与签名兼容性验证在 `.github/
 * workflows/qq-version-watch.yml` 里做（那一步需要平台 runner）。
 *
 * 用法：
 *   pnpm versions:refresh                  # 抓取 + 打印差异
 *   pnpm versions:refresh --write          # 同时落盘
 *   pnpm versions:refresh --check          # 只比对，落后则退出码 1（CI）
 *   pnpm versions:refresh --source <url>   # 用镜像/备用地址
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  diffLatest,
  mergeLatest,
  registerPending,
} from '../packages/service/src/bootstrap/qq_version_catalog';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERSIONS_DIR = join(ROOT, 'versions');
const LATEST_FILE = join(VERSIONS_DIR, 'latest.json');
const SUPPORTED_FILE = join(VERSIONS_DIR, 'supported.json');

const SOURCES = [
  'https://qq-web.cdn-go.cn/im.qq.com_new/latest/rainbow/pcConfig.json',
  'https://im.qq.com/proxy/domain/qq-web.cdn-go.cn/im.qq.com_new/latest/rainbow/pcConfig.json',
];

/**
 * 我们关心的五个平台 × 架构，与 `versions/supported.json` 的键一一对应。
 *
 * macOS 官方只发一个 universal dmg，但「能不能在某个架构上签名」要在对应架构的
 * runner 上分别验证，所以这里拆成两条，共用同一个下载地址。
 */
const TARGETS = [
  { key: 'windows-x64', config: 'Windows', urlKey: 'ntDownloadX64Url' },
  { key: 'linux-x64', config: 'Linux', urlKey: 'x64DownloadUrl', sub: 'deb' },
  { key: 'linux-arm64', config: 'Linux', urlKey: 'armDownloadUrl', sub: 'deb' },
  { key: 'macos-x64', config: 'macOS', urlKey: 'downloadUrl' },
  { key: 'macos-arm64', config: 'macOS', urlKey: 'downloadUrl' },
];

/** macOS 的 version 字段带后缀（`7.0.3 (Intel+Apple Silicon)`），只取号。 */
function normalizeVersion(raw) {
  if (typeof raw !== 'string') return null;
  const m = raw.trim().match(/^(\d+(?:\.\d+)+)/);
  return m ? m[1] : null;
}

/**
 * 官方给的路径形如
 *   …/QQNTV2/9.9.37/release/816b3c79/QQ_3.2.35_261103_amd64_01.deb
 *
 * 这个路径**不保证现在就能下**：实测新版本刚发布时 `QQNTV2/.../release` 直接
 * 403（防盗链 / 灰度），同批产物在 `QQNT/<ver>/beta/` 下也还没放出来；过几天
 * 往往就有了。所以这里**原样记录官网给的地址**，下载失败由 workflow 记 warning、
 * 跳过本轮，第二天再试 —— 不去猜 URL（猜出来的 build 号拼错只会更糟）。
 */

/** `downloadUrl` 有时是字符串、有时是 `{ deb, rpm, appimage }`。 */
function pickUrl(value, sub) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && sub && typeof value[sub] === 'string')
    return value[sub];
  if (value && typeof value === 'object') {
    // 没有指定子键时取第一个 http 开头的（deb 优先，和 TARGETS 的顺序一致）。
    for (const sub of ['deb', 'exe', 'dmg']) {
      if (typeof value[sub] === 'string') return value[sub];
    }
  }
  return null;
}

async function fetchConfig(source) {
  const res = await fetch(source, {
    headers: { 'user-agent': 'WeQ-version-watch/1.0 (+https://github.com/weq-devs/WeQ)' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${source} → HTTP ${res.status}`);
  return res.json();
}

async function loadConfig(explicitSource) {
  const sources = explicitSource ? [explicitSource] : SOURCES;
  const errors = [];
  for (const source of sources) {
    try {
      const json = await fetchConfig(source);
      return { json, source };
    } catch (error) {
      errors.push(`${source}: ${error instanceof Error ? error.message : error}`);
    }
  }
  throw new Error(`拿不到 QQ 版本配置：\n${errors.join('\n')}`);
}

function buildLatest(config, source) {
  const versions = {};
  for (const target of TARGETS) {
    const section = config[target.config];
    if (!section) continue;
    const version = normalizeVersion(section.version);
    if (!version) continue;
    versions[target.key] = {
      version,
      url: pickUrl(section[target.urlKey], target.sub),
      updateDate: section.updateDate ?? null,
    };
  }
  if (!Object.keys(versions).length) throw new Error('配置里没有识别出任何平台版本');
  return {
    // 抓取时间用 UTC；workflow 每晚跑，日期足够定位是哪一轮。
    fetchedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    source,
    versions,
  };
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return fallback;
  }
}

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function main() {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const check = args.includes('--check');
  const sourceIndex = args.indexOf('--source');
  const explicitSource = sourceIndex >= 0 ? args[sourceIndex + 1] : undefined;

  const { json, source } = await loadConfig(explicitSource);
  const fetched = buildLatest(json, source);
  const previous = readJson(LATEST_FILE, null);
  // 版本只允许前进：CDN 边缘节点不是同时更新的，某次抓到旧版本不能把已记录的
  // 新版本顶掉。
  const next = mergeLatest(previous, fetched);
  const allChanges = diffLatest(previous, next);
  const changes = allChanges.filter((c) => c.kind !== 'regression');

  const summary = Object.entries(next.versions)
    .map(([platform, info]) => `  ${platform.padEnd(16)} ${info.version}`)
    .join('\n');

  console.log(`QQ 版本清单（来源 ${source}）\n${summary}`);

  const regressions = allChanges.filter((c) => c.kind === 'regression');
  if (regressions.length) {
    console.log('\n官网这次返回了更旧的版本（CDN 灰度），按已记录版本为准：');
    for (const r of regressions) console.log(`  ${r.key}: 已记录 ${r.from}，本次 ${r.to}`);
  }

  if (!changes.length) {
    console.log('\n和上次一致，没有新版本。');
  } else {
    console.log('\n变化：');
    for (const change of changes) {
      console.log(`  ${change.key}: ${change.from ?? '（新增）'} → ${change.to}`);
    }
  }

  // GitHub Actions 用：让 workflow 决定要不要跑签名兼容性验证。
  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    const lines = [
      `changed=${changes.length > 0}`,
      `changes=${JSON.stringify(changes)}`,
      `versions=${JSON.stringify(next.versions)}`,
    ];
    writeFileSync(output, `${lines.join('\n')}\n`, { flag: 'a' });
  }

  if (check) {
    if (changes.length) {
      console.error('\n版本清单落后于官网（--check）。');
      process.exit(1);
    }
    return;
  }

  if (!write) {
    console.log('\n（未加 --write，不落盘）');
    return;
  }

  mkdirSync(VERSIONS_DIR, { recursive: true });
  writeFileSync(LATEST_FILE, serialize(next));
  const supported = readJson(SUPPORTED_FILE, { platforms: {}, pending: [] });
  writeFileSync(SUPPORTED_FILE, serialize(registerPending(supported, next)));
  console.log(`\n已写入 ${LATEST_FILE} 与 ${SUPPORTED_FILE}`);
}

// 只在直接执行时跑；被测试 import 时不触发网络请求。
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
