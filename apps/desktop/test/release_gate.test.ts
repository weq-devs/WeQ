// @vitest-environment node
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  releasePlan,
  frozenPlan,
  assertDraft,
  prepareRelease,
  publishRelease,
  assertReady,
  assertRemoteTag,
  requiredAssets,
  RELEASE_CHECKS,
} from '../../../scripts/release-control.mjs';

const root = resolve(__dirname, '../../..');
const require = createRequire(import.meta.url);
const builder = createRequire(require.resolve('electron-builder/package.json'));
const appBuilder = createRequire(builder.resolve('app-builder-lib/package.json'));
const { load } = appBuilder('js-yaml') as { load: (source: string) => unknown };
type Job = { needs?: string[]; uses?: string; steps?: { run?: string }[] };
const workflow = load(readFileSync(resolve(root, '.github/workflows/release.yml'), 'utf8')) as {
  env: Record<string, string>;
  jobs: Record<string, Job>;
};
const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(stable = false) {
  const plan = releasePlan({
    tag: 'v3.1.0',
    commit: 'a'.repeat(40),
    onMain: stable,
    onDev: true,
    subject: 'chore(release): fixture',
  });
  const release = {
    id: 123,
    tag_name: plan.tag,
    target_commitish: plan.commit,
    prerelease: plan.prerelease,
    draft: true,
    body: `weQ ${plan.tag}`,
  };
  const needs = Object.fromEntries(
    RELEASE_CHECKS.map((name: string) => [name, { result: 'success' }]),
  );
  const assets = requiredAssets(plan.version).map((name: string) => ({
    name,
    state: 'uploaded',
    size: 10,
  }));
  return { plan, release, needs, assets };
}

it('main 与 dev 共享历史时 main 优先，dev 独有与显式预发行标签为测试版', () => {
  expect(fixture(true).plan.prerelease).toBe(false);
  expect(fixture().plan.prerelease).toBe(true);
  expect(
    releasePlan({ ...fixture(true).plan, tag: 'v3.1.0-beta.1', onMain: true, onDev: true })
      .prerelease,
  ).toBe(true);
  expect(() => releasePlan({ ...fixture().plan, onMain: false, onDev: false })).toThrow();
  expect(() => releasePlan({ ...fixture().plan, tag: 'v3.1.0;echo bad', onMain: true })).toThrow();
  expect(() =>
    frozenPlan({ tag: 'v3.1.0', commit: 'a'.repeat(40), prerelease: undefined }),
  ).toThrow();
});

it('创建即正确分类为草稿；已有公开或错分类拒绝覆盖，提交按远端标签核对', async () => {
  const f = fixture();
  const api = vi.fn(async (method: string, path: string, body?: Record<string, unknown>) => {
    if (path.startsWith('/git/ref/')) return { object: { type: 'commit', sha: f.plan.commit } };
    return method === 'GET' ? [] : { ...f.release, ...body };
  });
  await prepareRelease(f.plan, api);
  expect(api.mock.calls.find(([method]) => method === 'POST')?.[2]).toMatchObject({
    draft: true,
    prerelease: true,
    target_commitish: f.plan.commit,
    name: f.plan.version,
  });
  for (const changed of [{ draft: false }, { prerelease: false }])
    expect(() => assertDraft({ ...f.release, ...changed }, f.plan)).toThrow();
  expect(() => assertDraft({ ...f.release, target_commitish: 'main' }, f.plan)).not.toThrow();
  const existing = vi.fn(async (_method: string, path: string) =>
    path.startsWith('/git/ref/')
      ? { object: { type: 'commit', sha: f.plan.commit } }
      : [{ ...f.release, draft: false }],
  );
  await expect(prepareRelease(f.plan, existing)).rejects.toThrow();
  expect(existing.mock.calls.some(([method]) => method === 'POST')).toBe(false);
});

it('Windows 上传成功但任一后续平台、CI 或说明失败时不公开', async () => {
  const f = fixture();
  for (const name of RELEASE_CHECKS) {
    const api = vi.fn(async (_method: string, path: string) =>
      path.includes('/assets') ? f.assets : f.release,
    );
    await expect(
      publishRelease(f.plan, f.release.id, { ...f.needs, [name]: { result: 'failure' } }, api),
    ).rejects.toThrow();
    expect(api).not.toHaveBeenCalled();
  }
});

it('每种必需产物及更新清单均检查完成状态，临时未完成上传也阻止公开', () => {
  const f = fixture();
  expect(() => assertReady(f.plan, f.needs, f.release, f.assets)).not.toThrow();
  for (const asset of f.assets)
    expect(() =>
      assertReady(
        f.plan,
        f.needs,
        f.release,
        f.assets.filter((item: { name: string }) => item.name !== asset.name),
      ),
    ).toThrow();
  expect(() =>
    assertReady(f.plan, f.needs, f.release, [
      ...f.assets,
      { name: 'unfinished', size: 0, state: 'starter' },
    ]),
  ).toThrow();
  expect(() => assertReady(f.plan, f.needs, { ...f.release, body: '' }, f.assets)).toThrow();
  expect(() =>
    assertReady(f.plan, f.needs, f.release, [{ ...f.assets[0], size: '10' }, ...f.assets.slice(1)]),
  ).toThrow();
});

it.each([false, true])(
  '最终公开 stable=%s 只改一次公开状态，回执丢失后的重跑只核验',
  async (stable) => {
    const f = fixture(stable);
    let release = { ...f.release, target_commitish: 'main' };
    const api = vi.fn(async (method: string, path: string, body?: Record<string, unknown>) => {
      if (path.startsWith('/git/ref/')) return { object: { type: 'commit', sha: f.plan.commit } };
      if (method === 'PATCH') {
        release = { ...release, ...body };
        return release;
      }
      return path.includes('/assets') ? f.assets : release;
    });
    await publishRelease(f.plan, release.id, f.needs, api);
    expect(api.mock.calls.find(([method]) => method === 'PATCH')?.[2]).toMatchObject({
      draft: false,
      prerelease: !stable,
      make_latest: stable ? 'legacy' : 'false',
    });
    api.mockClear();
    await publishRelease(f.plan, release.id, f.needs, api);
    expect(api.mock.calls.some(([method]) => method === 'PATCH')).toBe(false);
  },
);

it('远端标签必须仍绑定冻结提交，附注标签逐层剥离后核对', async () => {
  const f = fixture();
  const tagSha = 'b'.repeat(40);
  const api = vi.fn(async (_method: string, path: string) => ({
    object: path.startsWith('/git/ref/')
      ? { type: 'tag', sha: tagSha }
      : { type: 'commit', sha: f.plan.commit },
  }));
  await expect(assertRemoteTag(f.plan, api)).resolves.toBeUndefined();
  await expect(
    assertRemoteTag(f.plan, async () => ({ object: { type: 'commit', sha: tagSha } })),
  ).rejects.toThrow('已变化');
});

it('必须产物名来自实际 builder 宏规则，AppImage 与 tar 的 x64 名称不能混用', () => {
  const config = load(readFileSync(resolve(root, 'apps/desktop/electron-builder.yml'), 'utf8')) as {
    productName: string;
    nsis: { artifactName: string };
    linux: { artifactName: string };
    mac: { artifactName: string };
  };
  const { expandMacro } = appBuilder('app-builder-lib/out/util/macroExpander') as {
    expandMacro: (pattern: string, arch: string, info: object, extra: object) => string;
  };
  const { Arch, getArtifactArchName } = appBuilder('builder-util') as {
    Arch: Record<string, number>;
    getArtifactArchName: (arch: number, ext: string) => string;
  };
  const version = '3.1.0';
  const info = { sanitizedProductName: config.productName, version };
  const expected = [expandMacro(config.nsis.artifactName, 'x64', info, { ext: 'exe' })];
  for (const arch of ['x64', 'arm64']) {
    for (const ext of ['AppImage', 'tar.gz'])
      expected.push(
        expandMacro(config.linux.artifactName, getArtifactArchName(Arch[arch]!, ext), info, {
          ext,
        }),
      );
    for (const ext of ['dmg', 'zip'])
      expected.push(expandMacro(config.mac.artifactName, arch, info, { ext }));
  }
  expect(requiredAssets(version)).toEqual(expect.arrayContaining(expected));
});

it('真实 Git 图验证共享祖先、dev 独有提交和标签检出不匹配，不访问远端', () => {
  const dir = mkdtempSync(join(tmpdir(), 'weq-release-plan-'));
  temporary.push(dir);
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '-b', 'main');
  mkdirSync(join(dir, 'hooks'));
  git('config', 'core.hooksPath', join(dir, 'hooks'));
  git('config', 'commit.gpgsign', 'false');
  git('config', 'user.name', 'Synthetic');
  git('config', 'user.email', 'synthetic@example.invalid');
  writeFileSync(join(dir, 'fixture'), 'first');
  git('add', '.');
  git('commit', '-m', 'fixture');
  const first = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', first);
  git('update-ref', 'refs/remotes/origin/dev', first);
  git('tag', 'v3.0.0');
  const classify = (tag: string) => {
    const output = join(dir, 'output');
    writeFileSync(output, '');
    const child = spawnSync(
      process.execPath,
      [join(root, 'scripts/release-control.mjs'), 'classify'],
      { cwd: dir, env: { ...process.env, TAG: tag, GITHUB_OUTPUT: output }, encoding: 'utf8' },
    );
    return { child, output: readFileSync(output, 'utf8') };
  };
  expect(classify('v3.0.0').output).toContain('prerelease=false');
  git('checkout', '-b', 'dev');
  writeFileSync(join(dir, 'fixture'), 'second');
  git('add', '.');
  git('commit', '-m', 'fixture');
  git('update-ref', 'refs/remotes/origin/dev', git('rev-parse', 'HEAD'));
  git('tag', 'v3.0.1');
  expect(classify('v3.0.1').output).toContain('prerelease=true');
  expect(classify('v3.0.0').child.status).toBe(1);
});

it('全部产物上传前必须通过检查，所有上传只操作草稿', () => {
  const config = load(readFileSync(resolve(root, 'apps/desktop/electron-builder.yml'), 'utf8')) as {
    publish: { releaseType: string };
  };
  expect(config.publish.releaseType).toBe('draft');
  expect(workflow.env.EP_DRAFT).toBe('true');
  expect(workflow.jobs.checks?.uses).toBe('./.github/workflows/ci.yml');
  expect(workflow.jobs.prepare?.needs).toEqual(expect.arrayContaining(['gate', 'checks']));
  expect(workflow.jobs.windows?.needs).toContain('prepare');
});

it('只有最后公开任务可发布，任一平台失败不会越过该任务发通知', () => {
  const required = [
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
  expect(workflow.jobs.publish?.needs).toEqual(expect.arrayContaining(required));
  expect(workflow.jobs['qq-notify']?.needs).toContain('publish');
  expect(workflow.jobs.notes?.steps?.map((s) => s.run ?? '').join('\n')).not.toContain(
    '--prerelease',
  );
  const ci = load(readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')) as {
    on: Record<string, unknown>;
  };
  expect(ci.on).toHaveProperty('workflow_call');
});
