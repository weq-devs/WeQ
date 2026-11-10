#!/usr/bin/env node
/**
 * 用 GitHub Release 的 Linux tar.gz 更新 AUR 上的 `weq-bin`。
 *
 * 只在 release 工作流里自动跑；也能本地手动补发（CI 挂了的时候）：
 *   node scripts/publish-aur.mjs --version v2.6.0 [--dry-run] [--no-push]
 *
 * 为什么用 tar.gz 而不是 AppImage：AppImage 是单文件 FUSE 镜像，解不出
 * 「resources/ 与 native/ 和可执行文件同级」这个主进程依赖的布局；tar.gz 的
 * 目录结构原样搬到 /opt/weq 就能用。
 *
 * 哈希不下载 250 MB 的产物：GitHub Releases API 的 `assets[].digest` 就是
 * `sha256:<hex>`，v2.5.2 / v2.6.0 实测与本地 `sha256sum` 一致（见仓库文档）。
 *
 * 幂等：AUR 上已经是同一 pkgver + 同样内容时直接跳过；pkgver 不变但 PKGBUILD
 * 内容变了就 pkgrel++（AUR 惯例）。
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { versionInput } from './version-input.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKGNAME = 'weq-bin';

// PKGBUILD 源码里的字面量占位符（`${pkgname}` / `${pkgver}`）。用字符串拼接
// 而不是模板字面量，免得被当成这里自己的插值、也被 lint 当成笔误。
const PKGNAME_VAR = `\${pkgname}`;
const PKGVER_VAR = `\${pkgver}`;
const AUR_SSH = `ssh://aur@aur.archlinux.org/${PKGNAME}.git`;
const REPO = { owner: 'weq-devs', repo: 'WeQ' };

/** 从 Release API 的资产列表里取两个架构 tar.gz 的 sha256。 */
export function releaseHashes(assets, version) {
  const want = {
    x86_64: `weQ-${version}-linux-x64.tar.gz`,
    aarch64: `weQ-${version}-linux-arm64.tar.gz`,
  };
  const out = {};
  for (const [arch, name] of Object.entries(want)) {
    const asset = assets.find((candidate) => candidate.name === name);
    if (!asset) throw new Error(`Release 缺少产物：${name}`);
    const match = /^sha256:([a-f0-9]{64})$/.exec(asset.digest ?? '');
    if (!match) throw new Error(`Release 未提供 ${name} 的 sha256 digest`);
    out[arch] = match[1];
  }
  return out;
}

/**
 * 仓库内的 PKGBUILD 辅助文件。它们和上游 tar.gz 一样列在 `source` 里，
 * `makepkg` 才会放进 `$srcdir`；sha256 同样由这里算，避免手抄。
 */
export const AUX_FILES = ['weq.sh', 'weq.desktop'];

/** 用模板渲染出 PKGBUILD。缺占位符时直接失败，别把空哈希推上去。 */
export function renderPkgbuild(template, { version, hashes }) {
  const filled = template
    .replaceAll('@PKGVER@', version)
    .replaceAll('@SHA256_WEQ_SH@', hashes.weqSh)
    .replaceAll('@SHA256_WEQ_DESKTOP@', hashes.weqDesktop)
    .replaceAll('@SHA256_X86_64@', hashes.x86_64)
    .replaceAll('@SHA256_AARCH64@', hashes.aarch64);
  const leftover = filled.match(/@[A-Z0-9_]+@/g);
  if (leftover) throw new Error(`PKGBUILD 模板仍有未替换的占位符：${leftover.join(', ')}`);
  return filled;
}

/**
 * 生成 `.SRCINFO`，逐字节对齐 `makepkg --printsrcinfo`（字段顺序、缩进、
 * `source` 的 `文件名::URL` 写法都按它的实际输出，已用 2.6.0 的 PKGBUILD
 * 做过 diff 校验）。手写而不是 shell 出去跑 makepkg，是为了能在没有 pacman
 * 的 ubuntu runner 上也能生成。
 */
export function renderSrcinfo(pkgbuild) {
  // `.SRCINFO` 里一律是展开后的字面值（`makepkg --printsrcinfo` 的约定），
  // 所以 `${pkgname}` / `${pkgver}` 都要换成实际值。
  const scalar = (key) => {
    const match = new RegExp(`^${key}=(.*)$`, 'm').exec(pkgbuild);
    if (!match) throw new Error(`PKGBUILD 缺少 ${key}`);
    const raw = match[1].trim().replace(/^(['"])(.*)\1$/, '$2');
    const pkgname = /^pkgname=(.*)$/m
      .exec(pkgbuild)?.[1]
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2');
    const pkgver = /^pkgver=(.*)$/m
      .exec(pkgbuild)?.[1]
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2');
    return raw.replaceAll(PKGNAME_VAR, pkgname ?? '').replaceAll(PKGVER_VAR, pkgver ?? '');
  };
  /** 取 `key=( … )` 的整个数组体，允许跨行。 */
  const arrayBody = (key) => {
    const start = new RegExp(`^${key}=\\(`, 'm').exec(pkgbuild);
    if (!start) throw new Error(`PKGBUILD 缺少 ${key}`);
    const from = start.index + start[0].length;
    const end = pkgbuild.indexOf(')', from);
    if (end < 0) throw new Error(`PKGBUILD 的 ${key} 没有闭合`);
    return pkgbuild.slice(from, end);
  };
  const shellList = (key) =>
    [...arrayBody(key).matchAll(/'([^']*)'|"([^"]*)"/g)].map((entry) => entry[1] ?? entry[2]);
  // PKGBUILD 里写变量才是对的（升级只改一行），`.SRCINFO` 必须是展开值。
  const expand = (text) =>
    text.replaceAll(PKGVER_VAR, scalar('pkgver')).replaceAll(PKGNAME_VAR, scalar('pkgname'));
  /**
   * `source_<arch>` 的条目原样展开。`makepkg --printsrcinfo` 不会替 URL 补
   * `文件名::` 前缀 —— 实测输出就是裸 URL，文件名由 makepkg 自己从末段取。
   */
  const sourceOf = (arch) => shellList(`source_${arch}`).map(expand);

  const lines = [
    `pkgbase = ${scalar('pkgname')}`,
    `\tpkgdesc = ${scalar('pkgdesc')}`,
    `\tpkgver = ${scalar('pkgver')}`,
    `\tpkgrel = ${scalar('pkgrel')}`,
    `\turl = ${scalar('url')}`,
    // 字段顺序照抄 makepkg：install 紧跟在 url 之后、arch 之前。
    ...(/^install=.*$/m.test(pkgbuild) ? [`\tinstall = ${scalar('install')}`] : []),
    ...shellList('arch').map((value) => `\tarch = ${value}`),
    ...shellList('license').map((value) => `\tlicense = ${value}`),
    ...shellList('depends').map((value) => `\tdepends = ${value}`),
    ...shellList('optdepends').map((value) => `\toptdepends = ${value}`),
    ...shellList('provides').map((value) => `\tprovides = ${value}`),
    ...shellList('conflicts').map((value) => `\tconflicts = ${value}`),
    ...shellList('options').map((value) => `\toptions = ${value}`),
  ];
  for (const arch of shellList('arch')) {
    for (const entry of sourceOf(arch)) lines.push(`\tsource_${arch} = ${entry}`);
    for (const sum of shellList(`sha256sums_${arch}`)) lines.push(`\tsha256sums_${arch} = ${sum}`);
  }
  lines.push('', `pkgname = ${scalar('pkgname')}`);
  return `${lines.join('\n')}\n`;
}

/** 只改 pkgver 之外的内容时递增 pkgrel，避免同版本号覆盖。 */
export function nextPkgrel(previousPkgbuild, renderedPkgbuild) {
  const rel = (text) => Number(/^pkgrel=(\d+)$/m.exec(text)?.[1] ?? '1');
  const ver = (text) => /^pkgver=(.*)$/m.exec(text)?.[1] ?? '';
  if (ver(previousPkgbuild) !== ver(renderedPkgbuild)) return 1;
  // 渲染结果永远从 pkgrel=1 起算，递增要以 AUR 上的旧值为准。
  if (previousPkgbuild.trim() === renderedPkgbuild.trim()) return rel(previousPkgbuild);
  return rel(previousPkgbuild) + 1;
}

function git(cwd, args, inherit = false) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });
}

/** 本地辅助文件的 sha256；改了 weq.sh / weq.desktop 必须让 PKGBUILD 跟着变。 */
export function auxHashes() {
  const hash = (name) =>
    createHash('sha256')
      .update(readFileSync(join(repoRoot, 'packaging/aur', name)))
      .digest('hex');
  return { weqSh: hash('weq.sh'), weqDesktop: hash('weq.desktop') };
}

function releaseAssets(version) {
  const raw = execFileSync(
    'gh',
    [
      'api',
      `repos/${REPO.owner}/${REPO.repo}/releases/tags/v${version}`,
      '--jq',
      '.assets | map({name, digest})',
    ],
    { encoding: 'utf8' },
  );
  return JSON.parse(raw);
}

function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => argv.includes(`--${name}`);
  const value = (name) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const version = versionInput(value('version') ?? '');
  if (!version) throw new Error('用法：node scripts/publish-aur.mjs --version v<版本>');

  const template = readFileSync(join(repoRoot, 'packaging/aur/PKGBUILD.in'), 'utf8');
  const hashes = {
    ...releaseHashes(releaseAssets(version), version),
    ...auxHashes(),
  };
  const rendered = renderPkgbuild(template, { version, hashes });

  const work = mkdtempSync(join(tmpdir(), 'weq-aur-'));
  try {
    execFileSync('git', ['clone', '--depth', '1', AUR_SSH, work], {
      stdio: 'inherit',
    });
    let pkgbuild = rendered;
    let previous = '';
    try {
      previous = readFileSync(join(work, 'PKGBUILD'), 'utf8');
    } catch {
      // 首包：AUR 仓库是空的。
    }
    if (previous) {
      const pkgrel = nextPkgrel(previous, rendered);
      pkgbuild = rendered.replace(/^pkgrel=.*$/m, `pkgrel=${pkgrel}`);
      if (previous.trim() === pkgbuild.trim()) {
        console.log(`${PKGNAME}: AUR 已是 ${version}（pkgrel=${pkgrel}），无需更新`);
        return;
      }
    }

    const srcinfo = renderSrcinfo(pkgbuild);
    // 落盘前用 bash 做一次语法与取值自检，坏模板别推进 AUR。
    execFileSync('bash', ['-n', '-c', pkgbuild], { stdio: ['ignore', 'ignore', 'pipe'] });
    for (const required of ['pkgname', 'pkgver', 'source_x86_64', 'source_aarch64']) {
      if (!new RegExp(`^${required}=`, 'm').test(pkgbuild)) {
        throw new Error(`PKGBUILD 缺少 ${required}`);
      }
    }

    writeFileSync(join(work, 'PKGBUILD'), pkgbuild);
    writeFileSync(join(work, '.SRCINFO'), srcinfo);
    const published = [...AUX_FILES, `${PKGNAME}.install`];
    for (const name of published) {
      writeFileSync(join(work, name), readFileSync(join(repoRoot, 'packaging/aur', name)));
    }

    if (flag('dry-run')) {
      console.log(`--- PKGBUILD (${version}) ---\n${pkgbuild}`);
      console.log(`--- .SRCINFO ---\n${srcinfo}`);
      return;
    }

    const rel = /^pkgrel=(\d+)$/m.exec(pkgbuild)?.[1] ?? '1';
    git(work, ['add', 'PKGBUILD', '.SRCINFO', ...published]);
    git(work, ['commit', '-m', `upgpkg: ${PKGNAME} ${version}-${rel}`]);
    if (flag('no-push')) {
      console.log(`已提交到 ${work}（--no-push，未推送）`);
      return;
    }
    git(work, ['push', 'origin', 'HEAD:master'], true);
    console.log(`${PKGNAME}: 已更新 AUR 到 ${version}-${rel}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function isMain() {
  return !!process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
}

if (isMain()) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
