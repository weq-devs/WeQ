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
  MARKET_EMOJI_FEED_TAG,
  RESOURCE_FEED_TAG,
  RELEASE_SUMMARY_MAX_CHARS,
  signReleaseIndex,
  verifyReleaseIndex,
} from '../packages/network/src/release_metadata.mjs';
import { extractSection } from './extract-changelog.mjs';

const require = createRequire(new URL('../packages/network/package.json', import.meta.url));
const semver = require('semver');
const metadataAsset = (name) =>
  /^(?:enhancement-(?:packs-|engines-).+\.json|enhancement-(?:pack|dress-v2|market-emoji)\.json|index-manifest\.json|(?:latest|beta|alpha|rc).*\.yml)$/.test(
    name,
  );
const hash = (text) => createHash('sha256').update(text).digest('hex');
const isFeedTag = (tag) => [FEED_TAG, MARKET_EMOJI_FEED_TAG, RESOURCE_FEED_TAG].includes(tag);
const isMarketEmojiTag = (tag) => tag.startsWith('market-emoji-');
function resourceTrack(tag) {
  if (/^dress-index-[a-f0-9]{12,64}$/.test(tag)) return 'dress';
  if (/^market-emoji-[a-f0-9]{12,64}$/.test(tag)) return 'market-emoji';
  return null;
}

function releaseSummary(changelog, section) {
  const firstBullet = /^[-*][ \t]+(.+)$/m.exec(extractSection(changelog, section))?.[1];
  if (!firstBullet) return undefined;
  const summary = firstBullet
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*|`/g, '')
    .trim();
  return summary.length > RELEASE_SUMMARY_MAX_CHARS
    ? `${summary.slice(0, RELEASE_SUMMARY_MAX_CHARS - 1)}…`
    : summary;
}

export async function describeRelease(repository, release, readAsset) {
  if (release.draft !== false || !release.published_at || isFeedTag(release.tag_name))
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
  const resourceFeed =
    previous?.kind === 'resource-release-index' || incoming.some((entry) => entry.track);
  const channels = new Map();
  for (const release of [...(previous?.releases ?? []), ...incoming]) {
    const channel = resourceFeed ? `${release.track}:${release.prerelease}` : release.prerelease;
    const old = channels.get(channel);
    if (
      !old ||
      (release.version && old.version
        ? semver.gt(release.version, old.version)
        : Date.parse(release.publishedAt) > Date.parse(old.publishedAt))
    )
      channels.set(channel, release);
  }
  return {
    schemaVersion: 1,
    kind: resourceFeed ? 'resource-release-index' : 'release-index',
    repository,
    generatedAt: now.toISOString(),
    releases: [...channels.values()],
  };
}

export async function publishReleaseFeed({
  repository,
  tag,
  resourceTags,
  privateKey,
  publicKeys,
  api,
  readAsset,
  readChangelog,
  upload,
}) {
  // 缺签名密钥或与客户端公钥不匹配时，在任何远端写入之前失败。
  verifyReleaseIndex(
    signReleaseIndex(mergeReleaseIndex(repository, null, []), privateKey),
    repository,
    publicKeys,
  );
  const releases = await api('GET', '/releases?per_page=100');
  const publishingResources = resourceTags !== undefined;
  if (
    publishingResources &&
    (repository !== 'weq-devs/dress-resources' ||
      !resourceTags.length ||
      resourceTags.some((tag) => !resourceTrack(tag)) ||
      new Set(resourceTags.map(resourceTrack)).size !== resourceTags.length)
  )
    throw new Error('统一发布需要每种资源至多一个有效版本');
  const marketEmoji =
    !publishingResources && repository.endsWith('/dress-resources') && isMarketEmojiTag(tag);
  const feedTag = publishingResources
    ? RESOURCE_FEED_TAG
    : marketEmoji
      ? MARKET_EMOJI_FEED_TAG
      : FEED_TAG;
  const feed = releases.find((item) => item.tag_name === feedTag);
  let previous;
  const oldAsset = feed?.assets.find((item) => item.name === FEED_ASSET);
  if (oldAsset)
    previous = verifyReleaseIndex(JSON.parse(await readAsset(oldAsset)), repository, publicKeys);
  if (previous && (previous.kind === 'resource-release-index') !== publishingResources)
    throw new Error('现有签名索引类型与发布入口不匹配');
  const requested = (resourceTags ?? [tag]).map((tag) =>
    releases.find((release) => release.tag_name === tag),
  );
  if (requested.some((release) => !release)) throw new Error('没有找到本次已发布版本');
  const current = requested[0];
  const candidates =
    previous || publishingResources
      ? requested
      : releases
          .filter(
            (item) =>
              !item.draft &&
              item.published_at &&
              !isFeedTag(item.tag_name) &&
              (!repository.endsWith('/dress-resources') ||
                (!item.tag_name.startsWith('dress-index-') &&
                  isMarketEmojiTag(item.tag_name) === marketEmoji)) &&
              (!repository.endsWith('/WeQ') || semver.valid(item.tag_name)),
          )
          .sort((a, b) =>
            repository.endsWith('/WeQ')
              ? semver.rcompare(a.tag_name, b.tag_name)
              : Date.parse(b.published_at) - Date.parse(a.published_at),
          );
  const selected = new Map();
  for (const release of candidates) {
    const channel = publishingResources ? resourceTrack(release.tag_name) : release.prerelease;
    if (!selected.has(channel)) selected.set(channel, release);
  }
  const descriptions = [];
  for (const release of selected.values()) {
    const descriptor = await describeRelease(repository, release, readAsset);
    if (publishingResources) descriptor.track = resourceTrack(release.tag_name);
    if (repository.endsWith('/WeQ') && release.tag_name === tag && readChangelog) {
      const section = release.prerelease ? 'Unreleased' : tag;
      const summary = releaseSummary(await readChangelog(tag), section);
      if (summary) descriptor.summary = summary;
    }
    descriptions.push(descriptor);
  }
  const index = mergeReleaseIndex(repository, previous, descriptions);
  const signed = signReleaseIndex(index, privateKey);
  verifyReleaseIndex(signed, repository, publicKeys);
  const release =
    feed ??
    (await api('POST', '/releases', {
      tag_name: feedTag,
      target_commitish: current.target_commitish,
      name: publishingResources
        ? 'WeQ resource update feed'
        : marketEmoji
          ? 'WeQ market emoji update feed'
          : 'WeQ update feed',
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
  const upload = async (release, signed) => {
    const directory = await mkdtemp(join(tmpdir(), 'weq-release-feed-'));
    try {
      const path = join(directory, FEED_ASSET);
      await writeFile(path, JSON.stringify(signed));
      execFileSync('gh', [
        'release',
        'upload',
        release.tag_name,
        path,
        '--repo',
        repository,
        '--clobber',
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
  const result = await publishReleaseFeed({
    repository,
    tag: process.env.TAG,
    resourceTags: process.env.WEQ_RESOURCE_TAGS?.split(','),
    privateKey,
    publicKeys,
    api,
    readAsset,
    readChangelog: (tag) =>
      execFileSync('git', ['show', `refs/tags/${tag}:CHANGELOG.md`], { encoding: 'utf8' }),
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
