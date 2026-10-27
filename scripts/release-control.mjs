import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { versionInput } from './version-input.mjs';

export const RELEASE_CHECKS = [
  'gate',
  'checks',
  'prepare',
  'windows',
  'linux-x64',
  'linux-arm64',
  'macos-x64',
  'macos-arm64',
  'mac-merge-update-info',
  'web',
  'notes',
];
const PREPARING = '构建中；全部门禁通过后公开。';

export function releasePlan({ tag, commit, onMain, onDev, subject = '' }) {
  const version = versionInput(tag);
  if (!version || !tag.startsWith('v') || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(commit))
    throw new Error('发布标签或提交无效');
  if (!onMain && !onDev) throw new Error('标签不属于 main 或 dev，拒绝猜测发布类型');
  return {
    tag,
    version,
    commit,
    prerelease: version.split('+')[0].includes('-') || !onMain,
    notify: /^(?:merge|release:|chore\(release\):)/i.test(subject),
  };
}

function identity(release, plan) {
  if (
    !release ||
    !Number.isSafeInteger(release.id) ||
    release.id < 1 ||
    release.tag_name !== plan.tag ||
    release.prerelease !== plan.prerelease
  )
    throw new Error('Release 身份或预发布分类不匹配');
}
export function assertDraft(release, plan) {
  identity(release, plan);
  if (release.draft !== true) throw new Error('已公开的 Release 不接受构建覆盖');
}

async function pages(api, path) {
  const all = [];
  for (let page = 1; page <= 50; page++) {
    const data = await api('GET', `${path}?per_page=100&page=${page}`);
    if (!Array.isArray(data)) throw new Error('GitHub 分页响应无效');
    all.push(...data);
    if (data.length < 100) return all;
  }
  throw new Error('GitHub 分页超过安全上限');
}

export async function prepareRelease(plan, api) {
  await assertRemoteTag(plan, api);
  const matches = (await pages(api, '/releases')).filter(
    (release) => release.tag_name === plan.tag,
  );
  if (matches.length > 1) throw new Error('同标签存在多个 Release，需人工核对');
  const release =
    matches[0] ??
    (await api('POST', '/releases', {
      tag_name: plan.tag,
      target_commitish: plan.commit,
      name: plan.version,
      body: PREPARING,
      draft: true,
      prerelease: plan.prerelease,
    }));
  assertDraft(release, plan);
  return release;
}

export function requiredAssets(version) {
  const desktop = [
    `weQ-${version}-setup.exe`,
    ...['x64', 'arm64'].flatMap((arch) => [
      `weQ-${version}-mac-${arch}.dmg`,
      `weQ-${version}-mac-${arch}.zip`,
      `weQ-${version}-linux-${arch === 'x64' ? 'x86_64' : arch}.AppImage`,
      `weQ-${version}-linux-${arch}.tar.gz`,
    ]),
  ];
  return [
    ...desktop,
    ...['win32-x64', 'linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'].map(
      (target) => `weq-web-${version}-${target}.tar.gz`,
    ),
    'latest.yml',
    'latest-linux.yml',
    'latest-linux-arm64.yml',
    'latest-mac.yml',
  ];
}

export function assertReady(plan, needs, release, assets) {
  assertChecks(needs);
  identity(release, plan);
  if (
    typeof release.body !== 'string' ||
    !release.body.includes(plan.tag) ||
    release.body === PREPARING
  )
    throw new Error('Release 说明尚未完成');
  for (const name of requiredAssets(plan.version)) {
    const matches = assets.filter((asset) => asset.name === name);
    if (
      matches.length !== 1 ||
      matches[0].state !== 'uploaded' ||
      !Number.isSafeInteger(matches[0].size) ||
      matches[0].size <= 0
    )
      throw new Error(`发布产物不完整：${name}`);
  }
  if (
    assets.some(
      (asset) => asset.state !== 'uploaded' || !Number.isSafeInteger(asset.size) || asset.size <= 0,
    )
  )
    throw new Error('Release 尚有未完成的上传');
}

function assertChecks(needs) {
  for (const name of RELEASE_CHECKS)
    if (needs?.[name]?.result !== 'success') throw new Error(`发布检查 ${name} 未成功`);
}

export async function assertRemoteTag(plan, api) {
  let object = (await api('GET', `/git/ref/tags/${encodeURIComponent(plan.tag)}`)).object;
  for (let depth = 0; depth < 8; depth++) {
    if (!object || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(object.sha))
      throw new Error('远端标签对象无效');
    if (object.type === 'commit') {
      if (object.sha !== plan.commit) throw new Error('远端标签已变化，拒绝公开旧提交产物');
      return;
    }
    if (object.type !== 'tag') throw new Error('远端标签未指向提交');
    object = (await api('GET', `/git/tags/${object.sha}`)).object;
  }
  throw new Error('远端标签嵌套过深');
}

export async function publishRelease(plan, id, needs, api) {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Release ID 无效');
  assertChecks(needs);
  await assertRemoteTag(plan, api);
  const release = await api('GET', `/releases/${id}`);
  if (release.id !== id) throw new Error('GitHub 返回的 Release ID 不匹配');
  const assets = await pages(api, `/releases/${id}/assets`);
  assertReady(plan, needs, release, assets);
  if (release.draft === false) return release; // 上次 PATCH 已完成但回执丢失：核验，不盲目重放。
  assertDraft(release, plan);
  const published = await api('PATCH', `/releases/${id}`, {
    draft: false,
    prerelease: plan.prerelease,
    make_latest: plan.prerelease ? 'false' : 'legacy',
  });
  identity(published, plan);
  if (published.id !== id) throw new Error('GitHub 公开回执的 Release ID 不匹配');
  if (published.draft !== false) throw new Error('GitHub 尚未确认公开 Release');
  return published;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}
function ancestor(commit, ref) {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', commit, ref]);
  if (result.status !== 0 && result.status !== 1) throw new Error(`无法核对发布分支 ${ref}`);
  return result.status === 0;
}
export function planFromGit(tag) {
  if (!versionInput(tag) || !tag.startsWith('v')) throw new Error('发布标签无效');
  const commit = git(['rev-parse', 'HEAD']);
  if (git(['rev-parse', '--verify', `${tag}^{commit}`]) !== commit)
    throw new Error('标签指向与当前检出不一致');
  return releasePlan({
    tag,
    commit,
    subject: git(['log', '-1', '--pretty=format:%s']),
    onMain: ancestor(commit, 'refs/remotes/origin/main'),
    onDev: ancestor(commit, 'refs/remotes/origin/dev'),
  });
}

export function frozenPlan({ tag, commit, prerelease }) {
  if (prerelease !== 'true' && prerelease !== 'false') throw new Error('缺少前置发布分类');
  const plan = releasePlan({ tag, commit, onMain: prerelease === 'false', onDev: true });
  if (plan.prerelease !== (prerelease === 'true')) throw new Error('发布标签与前置分类不一致');
  return plan;
}

async function main() {
  const action = process.argv[2];
  const plan =
    action === 'classify'
      ? planFromGit(process.env.TAG)
      : frozenPlan({
          tag: process.env.TAG,
          commit: process.env.RELEASE_COMMIT,
          prerelease: process.env.PRERELEASE,
        });
  if (
    action !== 'classify' &&
    (git(['rev-parse', 'HEAD']) !== plan.commit ||
      git(['rev-parse', '--verify', `${plan.tag}^{commit}`]) !== plan.commit)
  )
    throw new Error('发布检出与前置提交不一致');
  if (action === 'classify') {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `release=${plan.notify}\nprerelease=${plan.prerelease}\ncommit=${plan.commit}\n`,
    );
    return;
  }
  const repo = process.env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error('GitHub 仓库标识无效');
  const api = async (method, path, body) =>
    JSON.parse(
      execFileSync(
        'gh',
        [
          'api',
          '--method',
          method,
          '-H',
          'Accept: application/vnd.github+json',
          '-H',
          'X-GitHub-Api-Version: 2022-11-28',
          `repos/${repo}${path}`,
          ...(body ? ['--input', '-'] : []),
        ],
        {
          encoding: 'utf8',
          input: body ? JSON.stringify(body) : undefined,
          maxBuffer: 16 * 1024 * 1024,
        },
      ),
    );
  if (action === 'prepare') {
    const release = await prepareRelease(plan, api);
    appendFileSync(process.env.GITHUB_OUTPUT, `id=${release.id}\n`);
  } else if (action === 'publish') {
    await publishRelease(
      plan,
      Number(process.env.RELEASE_ID),
      JSON.parse(process.env.RELEASE_NEEDS),
      api,
    );
  } else throw new Error('未知发布操作');
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
