import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ANNOUNCEMENT_ASSET,
  ANNOUNCEMENT_REPOSITORY,
  MAX_ANNOUNCEMENT_BYTES,
  announcementReleaseUrl,
  signAnnouncementFeed,
  validateAnnouncementFeed,
  verifyAnnouncementFeed,
} from '../packages/network/src/announcement_metadata.mjs';
import { FEED_TAG } from '../packages/network/src/release_metadata.mjs';
import { extractSection } from './extract-changelog.mjs';
import { versionInput } from './version-input.mjs';

function withReleaseLink(entry) {
  if (!entry.releaseVersion) return entry;
  const url = announcementReleaseUrl(entry.releaseVersion);
  if (entry.body.includes(`](${url})`) || entry.body.includes(`<${url}>`)) return entry;
  return { ...entry, body: `${entry.body.trimEnd()}\n\n[查看发布页](${url})` };
}

function feed(entries, revision) {
  return validateAnnouncementFeed({
    schemaVersion: 1,
    kind: 'official-announcements',
    repository: ANNOUNCEMENT_REPOSITORY,
    revision,
    entries,
  });
}

function withReleaseLinks(data) {
  return { ...data, entries: data.entries.map(withReleaseLink) };
}

export async function publishAnnouncements({ entries, permission, ...transport }) {
  if (!['ADMIN', 'MAINTAIN'].includes(permission))
    throw new Error('只有 WeQ 官方仓库的维护者或管理员可发布公告');
  const result = await writeAnnouncements({
    ...transport,
    compose: (_, revision) => withReleaseLinks(feed(entries, revision)),
  });
  return result.feed;
}

export async function publishReleaseAnnouncement({ tag, release, changelog, ...transport }) {
  const version = versionInput(tag);
  if (
    !version ||
    !tag.startsWith('v') ||
    version.split('+')[0].includes('-') ||
    release?.tag_name !== tag ||
    release.draft !== false ||
    release.prerelease !== false ||
    !Number.isSafeInteger(release.id) ||
    release.id < 1 ||
    !release.published_at
  )
    throw new Error('只能为已公开的 WeQ 正式版本发布公告');
  const id = `weq-release-${release.id}`;
  return writeAnnouncements({
    ...transport,
    compose: (previous, revision) => {
      const entries = previous?.entries ?? [];
      if (entries.some((entry) => entry.id === id || entry.releaseVersion === version)) return null;
      const body = extractSection(changelog, tag);
      if (!body.trim()) throw new Error(`CHANGELOG.md 里没有 ${version} 的公告正文`);
      const entry = withReleaseLink({
        id,
        title: `WeQ ${version} 正式发布`,
        body,
        publishedAt: release.published_at,
        level: 'normal',
        releaseVersion: version,
      });
      return feed([...entries, entry], revision);
    },
  });
}

async function writeAnnouncements({ compose, signingKey, publicKeys, read, backup, upload }) {
  const previous = await read();
  const current = previous ? verifyAnnouncementFeed(previous, publicKeys) : null;
  const next = compose(current, (current?.revision ?? 0) + 1);
  if (!next) return { feed: current, published: false };
  const signed = signAnnouncementFeed(next, await signingKey());
  verifyAnnouncementFeed(signed, publicKeys);
  const previousPath = previous ? await backup(previous, current.revision) : null;
  if ((await read())?.signature !== previous?.signature)
    throw new Error('线上公告已更新，请基于最新修订重试');
  try {
    await upload(signed);
    const latest = await read();
    verifyAnnouncementFeed(latest, publicKeys);
    if (latest.signature !== signed.signature) throw new Error('线上内容与本次签名不一致');
  } catch (error) {
    let status;
    try {
      const latest = await read();
      if (latest) {
        const verified = verifyAnnouncementFeed(latest, publicKeys);
        if (latest.signature === signed.signature) return { feed: verified, published: true };
        status = `线上仍是修订 ${verified.revision}`;
      } else status = '线上公告文件缺失';
    } catch {
      status = '未能确认线上公告文件状态';
    }
    throw new Error(
      `${status}；${previousPath ? `替换前签名文件：${previousPath}` : '未替换已有公告'}`,
      { cause: error },
    );
  }
  return { feed: next, published: true };
}

async function main() {
  const [action, file] = process.argv.slice(2);
  const automatic = action === 'publish-release' && file === undefined;
  const repository = ANNOUNCEMENT_REPOSITORY;
  const tag = process.env.GITHUB_REF_NAME;
  if (!automatic && (!file || !['check', 'publish'].includes(action)))
    throw new Error(
      '用法：node scripts/publish-announcements.mjs <check|publish> <清单.json>，或在正式发版工作流中使用 publish-release',
    );
  if (
    automatic &&
    (process.env.GITHUB_ACTIONS !== 'true' ||
      process.env.GITHUB_EVENT_NAME !== 'push' ||
      process.env.GITHUB_REPOSITORY !== repository ||
      !tag?.startsWith('v') ||
      process.env.GITHUB_REF !== `refs/tags/${tag}` ||
      !process.env.WEQ_RELEASE_SIGNING_KEY)
  )
    throw new Error('自动公告只能在 WeQ 官方标签发布工作流中运行');
  const entries = automatic ? undefined : JSON.parse(await readFile(file, 'utf8'));
  if (action === 'check') {
    const { privateKey } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    signAnnouncementFeed(withReleaseLinks(feed(entries, 1)), privateKey);
    console.log(`公告清单有效：${entries.length} 条`);
    return;
  }
  const releaseHome = join(homedir(), 'Library/Application Support/WeQ-release');
  const signingKey = async () =>
    process.env.WEQ_RELEASE_SIGNING_KEY ??
    (await readFile(join(releaseHome, 'release-metadata-ed25519.pem'), 'utf8'));
  const publicKeys = JSON.parse(
    await readFile(new URL('../packages/network/src/release_keys.json', import.meta.url), 'utf8'),
  );
  const gh = (...args) =>
    execFileSync('gh', args, { encoding: 'utf8', maxBuffer: MAX_ANNOUNCEMENT_BYTES * 2 });
  const read = async () => {
    const release = JSON.parse(gh('api', `repos/${repository}/releases/tags/${FEED_TAG}`));
    if (release.draft || release.immutable) throw new Error('公告发布渠道不可更新');
    const asset = release.assets.find(({ name }) => name === ANNOUNCEMENT_ASSET);
    if (!asset) return null;
    if (asset.state !== 'uploaded' || asset.size > MAX_ANNOUNCEMENT_BYTES)
      throw new Error('线上公告文件状态或大小无效');
    return JSON.parse(
      gh(
        'api',
        '-H',
        'Accept: application/octet-stream',
        `repos/${repository}/releases/assets/${asset.id}`,
      ),
    );
  };
  const backup = async (previous, revision) => {
    const root = resolve(
      process.env.WEQ_ANNOUNCEMENT_BACKUP_DIR ?? join(releaseHome, 'announcements'),
    );
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, `revision-${revision}-`));
    const path = join(directory, ANNOUNCEMENT_ASSET);
    await writeFile(path, JSON.stringify(previous));
    return path;
  };
  const upload = async (signed) => {
    const directory = await mkdtemp(join(tmpdir(), 'weq-announcements-'));
    try {
      const path = join(directory, ANNOUNCEMENT_ASSET);
      await writeFile(path, JSON.stringify(signed));
      gh('release', 'upload', FEED_TAG, path, '--repo', repository, '--clobber');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
  const transport = { signingKey, publicKeys, read, backup, upload };
  let result;
  if (automatic) {
    const release = JSON.parse(
      gh('api', `repos/${repository}/releases/tags/${encodeURIComponent(tag)}`),
    );
    const outcome = await publishReleaseAnnouncement({
      ...transport,
      tag,
      release,
      changelog: await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8'),
    });
    if (!outcome.published) {
      console.log(`${tag} 的发布公告已存在，未改动线上清单`);
      return;
    }
    result = outcome.feed;
  } else {
    const { viewerPermission: permission } = JSON.parse(
      gh('repo', 'view', repository, '--json', 'viewerPermission'),
    );
    result = await publishAnnouncements({ ...transport, entries, permission });
  }
  console.log(`官方公告已发布并验签：修订 ${result.revision}，${result.entries.length} 条`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    if (error.cause instanceof Error) console.error(error.cause.message);
    process.exitCode = 1;
  });
}
