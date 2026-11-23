import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { describeRelease, mergeReleaseIndex, publishReleaseFeed } from './publish-release-feed.mjs';
import {
  MARKET_EMOJI_FEED_TAG,
  verifyReleaseIndex,
} from '../packages/network/src/release_metadata.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const catalog = JSON.stringify({ schemaVersion: 1 });
const release = (version = '2.7.2') => ({
  id: 1,
  tag_name: `v${version}`,
  draft: false,
  prerelease: false,
  published_at: '2026-11-16T00:00:00Z',
  assets: [
    {
      id: 10,
      name: 'enhancement-packs-darwin-arm64.json',
      state: 'uploaded',
      size: Buffer.byteLength(catalog),
      digest: `sha256:${hash(catalog)}`,
    },
    {
      id: 11,
      name: `weQ-${version}-mac-arm64.zip`,
      state: 'uploaded',
      size: 4,
      digest: `sha256:${hash('data')}`,
    },
  ],
});
test('从官方资产生成签名身份，不下载应用大文件', async () => {
  let reads = 0;
  const descriptor = await describeRelease('weq-devs/WeQ', release(), async () => {
    reads++;
    return catalog;
  });
  assert.equal(reads, 1);
  assert.equal(descriptor.assets[1].sha256, hash('data'));
  await assert.rejects(
    describeRelease('weq-devs/WeQ', { ...release(), draft: true }, async () => catalog),
  );
});
test('旧任务不能覆盖更新的渠道版本', async () => {
  const newer = await describeRelease('weq-devs/WeQ', release('2.8.0'), async () => catalog);
  const older = await describeRelease('weq-devs/WeQ', release('2.7.2'), async () => catalog);
  assert.equal(
    mergeReleaseIndex('weq-devs/WeQ', { releases: [newer] }, [older]).releases[0].version,
    '2.8.0',
  );
});
test('表情目录和装扮索引使用独立签名索引', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const releaseTag = 'market-emoji-0123456789ab';
  const market = {
    ...release(),
    tag_name: releaseTag,
    assets: [{ ...release().assets[0], name: 'enhancement-market-emoji.json' }],
  };
  const dress = { ...release(), tag_name: 'dress-1', published_at: '2026-11-17T00:00:00Z' };
  const writes = [];
  const repository = 'weq-devs/dress-resources';
  const publicKeys = [publicKey.export({ type: 'spki', format: 'pem' }).toString()];
  await publishReleaseFeed({
    repository,
    tag: releaseTag,
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeys,
    api: async (method, _path, body) => {
      if (method === 'GET') return [dress, market];
      writes.push(body);
      return { id: 2, draft: true };
    },
    readAsset: async () => catalog,
    upload: async (_release, signed) => {
      const { releases } = verifyReleaseIndex(signed, repository, publicKeys);
      assert.deepEqual(
        releases.map((item) => item.tag),
        [releaseTag],
      );
      assert.equal(releases[0].catalogs['enhancement-market-emoji.json'], catalog);
    },
  });
  assert.equal(writes[0].tag_name, MARKET_EMOJI_FEED_TAG);
});
test('先核对签名者，再创建及公开索引；错误密钥不产生远端写入', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const key = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const keys = [publicKey.export({ type: 'spki', format: 'pem' }).toString()];
  const writes = [];
  const api = async (method, path) => {
    if (method !== 'GET') writes.push([method, path]);
    return method === 'GET' ? [release()] : { id: 2, draft: true };
  };
  await assert.rejects(
    publishReleaseFeed({
      repository: 'weq-devs/WeQ',
      tag: 'v2.7.2',
      privateKey: key,
      publicKeys: [],
      api,
      readAsset: async () => catalog,
      upload: async () => {},
    }),
  );
  assert.equal(writes.length, 0);
  let uploaded;
  await publishReleaseFeed({
    repository: 'weq-devs/WeQ',
    tag: 'v2.7.2',
    privateKey: key,
    publicKeys: keys,
    api,
    readAsset: async () => catalog,
    readChangelog: async (tag) => {
      assert.equal(tag, 'v2.7.2');
      return [
        '# Changelog',
        '## Unreleased - 进行中',
        '- 尚未发布',
        '## 2.7.2 - 2026-11-16',
        '### 副标题',
        '- **更新说明**：查看[详情](https://example.com)。',
        '## 2.7.1 - 2026-11-15',
        '- 上一版',
      ].join('\n');
    },
    upload: async (_release, signed) => {
      uploaded = signed;
    },
  });
  const [published] = verifyReleaseIndex(uploaded, 'weq-devs/WeQ', keys).releases;
  assert.equal(published.version, '2.7.2');
  assert.equal(published.summary, '更新说明：查看详情。');
  assert.deepEqual(
    writes.map(([method]) => method),
    ['POST', 'PATCH'],
  );
});
