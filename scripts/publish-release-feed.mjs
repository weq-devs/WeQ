import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FEED_TAG,
  FEED_ASSET,
  signReleaseIndex,
  verifyReleaseIndex,
} from '../packages/network/src/release_metadata.mjs';

const require = createRequire(new URL('../packages/network/package.json', import.meta.url));
const semver = require('semver');
const metadataAsset = (name) =>
  /^(?:enhancement-(?:packs-|engines-).+\.json|enhancement-pack\.json|index-manifest\.json|(?:latest|beta|alpha|rc).*\.yml)$/.test(
    name,
  );
const hash = (text) => createHash('sha256').update(text).digest('hex');

export async function describeRelease(repository, release, readAsset) {
  if (release.draft !== false || !release.published_at || release.tag_name === FEED_TAG)
    throw new Error('只能为已确认公开的正式资源生成索引');
  const version = repository.endsWith('/WeQ') ? semver.valid(release.tag_name) : null;
  if (repository.endsWith('/WeQ') && !version) throw new Error('应用发布标签不是有效版本');
  const catalogs = {};
  const assets = [];
  for (const asset of release.assets) {
    if (asset.state !== 'uploaded' || !Number.isSafeInteger(asset.size) || asset.size <= 0)
      throw new Error(`发布资产尚未完成：${asset.name}`);
    let digest = /^sha256:([a-f0-9]{64})$/.exec(asset.digest ?? '')?.[1];
    if (metadataAsset(asset.name)) {
      if (asset.size > 2 * 1024 ** 2) throw new Error('发布描述过大');
      const text = await readAsset(asset);
      if (Buffer.byteLength(text) !== asset.size || (digest && hash(text) !== digest))
        throw new Error(`官方资产摘要不匹配：${asset.name}`);
      digest = hash(text);
      if (asset.name.endsWith('.json')) JSON.parse(text);
      // 索引携带原始描述字节，不让镜像重新声明资产哈希。
      catalogs[asset.name] = text;
    }
    if (!digest) throw new Error(`官方 Release 缺少文件摘要：${asset.name}`);
    assets.push({ name: asset.name, size: asset.size, sha256: digest });
  }
  return {
    tag: release.tag_name,
    version,
    prerelease: release.prerelease,
    publishedAt: release.published_at,
    assets,
    catalogs,
  };
}
export function mergeReleaseIndex(repository, previous, incoming, now = new Date()) {
  const channels = new Map();
  for (const release of [...(previous?.releases ?? []), ...incoming]) {
    const old = channels.get(release.prerelease);
    if (
      !old ||
      (release.version && old.version
        ? semver.gt(release.version, old.version)
        : Date.parse(release.publishedAt) > Date.parse(old.publishedAt))
    )
      channels.set(release.prerelease, release);
  }
  return {
    schemaVersion: 1,
    kind: 'release-index',
    repository,
    generatedAt: now.toISOString(),
    releases: [...channels.values()],
  };
}

export async function publishReleaseFeed({
  repository,
  tag,
  privateKey,
  publicKeys,
  api,
  readAsset,
  upload,
}) {
  // 缺签名密钥或与客户端公钥不匹配时，在任何远端写入之前失败。
  verifyReleaseIndex(
    signReleaseIndex(mergeReleaseIndex(repository, null, []), privateKey),
    repository,
    publicKeys,
  );
  const releases = await api('GET', '/releases?per_page=100');
  const feed = releases.find((item) => item.tag_name === FEED_TAG);
  let previous;
  const oldAsset = feed?.assets.find((item) => item.name === FEED_ASSET);
  if (oldAsset)
    previous = verifyReleaseIndex(JSON.parse(await readAsset(oldAsset)), repository, publicKeys);
  const current = releases.find((item) => item.tag_name === tag);
  if (!current) throw new Error('没有找到本次已发布版本');
  const candidates = previous
    ? [current]
    : releases
        .filter(
          (item) =>
            !item.draft &&
            item.published_at &&
            item.tag_name !== FEED_TAG &&
            (!repository.endsWith('/WeQ') || semver.valid(item.tag_name)),
        )
        .sort((a, b) =>
          repository.endsWith('/WeQ')
            ? semver.rcompare(a.tag_name, b.tag_name)
            : Date.parse(b.published_at) - Date.parse(a.published_at),
        );
  const selected = new Map();
  for (const release of candidates)
    if (!selected.has(release.prerelease)) selected.set(release.prerelease, release);
  const descriptions = [];
  for (const release of selected.values())
    descriptions.push(await describeRelease(repository, release, readAsset));
  const index = mergeReleaseIndex(repository, previous, descriptions);
  const signed = signReleaseIndex(index, privateKey);
  verifyReleaseIndex(signed, repository, publicKeys);
  const release =
    feed ??
    (await api('POST', '/releases', {
      tag_name: FEED_TAG,
      target_commitish: current.target_commitish,
      name: 'WeQ update feed',
      draft: true,
      prerelease: true,
      make_latest: 'false',
      body: '机器读取的签名更新索引，不是应用版本。',
    }));
  await upload(release, signed);
  if (release.draft)
    await api('PATCH', `/releases/${release.id}`, { draft: false, make_latest: 'false' });
  return index;
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) throw new Error('缺少发布仓标识');
  const publicKeys = JSON.parse(
    await readFile(new URL('../packages/network/src/release_keys.json', import.meta.url), 'utf8'),
  );
  const privateKey =
    process.env.WEQ_RELEASE_SIGNING_KEY ??
    (await readFile(
      join(homedir(), 'Library/Application Support/WeQ-release/release-metadata-ed25519.pem'),
      'utf8',
    ));
  if (process.argv.includes('--check-key')) {
    verifyReleaseIndex(
      signReleaseIndex(mergeReleaseIndex(repository, null, []), privateKey),
      repository,
      publicKeys,
    );
    console.log('发布签名密钥与客户端公钥匹配');
    return;
  }
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
          `repos/${repository}${path}`,
          ...(body ? ['--input', '-'] : []),
        ],
        {
          encoding: 'utf8',
          input: body ? JSON.stringify(body) : undefined,
          maxBuffer: 8 * 1024 ** 2,
        },
      ),
    );
  const readAsset = async (asset) =>
    execFileSync(
      'gh',
      [
        'api',
        '-H',
        'Accept: application/octet-stream',
        `repos/${repository}/releases/assets/${asset.id}`,
      ],
      { encoding: 'utf8', maxBuffer: 8 * 1024 ** 2 },
    );
  const upload = async (_release, signed) => {
    const directory = await mkdtemp(join(tmpdir(), 'weq-release-feed-'));
    try {
      const path = join(directory, FEED_ASSET);
      await writeFile(path, JSON.stringify(signed));
      execFileSync('gh', ['release', 'upload', FEED_TAG, path, '--repo', repository, '--clobber']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
  const result = await publishReleaseFeed({
    repository,
    tag: process.env.TAG,
    privateKey,
    publicKeys,
    api,
    readAsset,
    upload,
  });
  console.log(
    `已更新 ${repository} 的签名索引：${result.releases.map((item) => item.tag).join(', ')}`,
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
