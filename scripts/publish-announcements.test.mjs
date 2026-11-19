import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { verifyAnnouncementFeed } from '../packages/network/src/announcement_metadata.mjs';
import { signReleaseIndex } from '../packages/network/src/release_metadata.mjs';
import { publishAnnouncements } from './publish-announcements.mjs';

const keys = generateKeyPairSync('ed25519', {
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const entry = {
  id: 'test',
  title: '示例',
  body: '公告正文',
  level: 'normal',
  publishedAt: '2026-11-19T02:00:00Z',
};

test('独立发布、预留上版签名，再以更高修订撤回', async () => {
  let origin = null;
  const backups = [];
  const options = {
    permission: 'MAINTAIN',
    signingKey: () => keys.privateKey,
    publicKeys: [keys.publicKey],
    read: async () => origin,
    backup: async (old) => {
      backups.push(old);
      return '/fixture/previous.json';
    },
    upload: async (signed) => {
      origin = signed;
    },
  };
  const releaseNotice = { ...entry, releaseVersion: '2.8.0' };
  const first = await publishAnnouncements({ ...options, entries: [releaseNotice] });
  assert.equal(first.revision, 1);
  const url = 'https://github.com/weq-devs/WeQ/releases/tag/v2.8.0';
  assert.deepEqual(first.entries, [
    { ...releaseNotice, body: `${entry.body}\n\n[查看发布页](${url})` },
  ]);
  const next = await publishAnnouncements({ ...options, entries: [] });
  assert.equal(next.revision, 2);
  assert.deepEqual(verifyAnnouncementFeed(origin, options.publicKeys).entries, []);
  assert.deepEqual(verifyAnnouncementFeed(backups[0], options.publicKeys).entries, first.entries);
  await assert.rejects(
    publishAnnouncements({
      ...options,
      entries: [entry],
      upload: async () => {
        origin = null;
        throw Error('upload');
      },
    }),
    /线上公告文件缺失；替换前签名文件：\/fixture\/previous\.json/,
  );
});

test('复用已有的官方发布页链接，不重复追加', async () => {
  let origin = null;
  const releaseNotice = {
    ...entry,
    releaseVersion: '2.8.0',
    body: `${entry.body}\n\n[更新说明](https://github.com/weq-devs/WeQ/releases/tag/v2.8.0)`,
  };
  const result = await publishAnnouncements({
    entries: [releaseNotice],
    permission: 'MAINTAIN',
    signingKey: () => keys.privateKey,
    publicKeys: [keys.publicKey],
    read: async () => origin,
    upload: async (signed) => {
      origin = signed;
    },
  });
  assert.deepEqual(result.entries, [releaseNotice]);
});

test('不允许无截止时间的重要公告或重复 ID 写入渠道，不接受更新索引签名', async () => {
  const options = {
    permission: 'ADMIN',
    signingKey: () => keys.privateKey,
    publicKeys: [keys.publicKey],
    read: async () => null,
    backup: async () => assert.fail('invalid feed cannot back up'),
    upload: async () => assert.fail('invalid feed cannot upload'),
  };
  await assert.rejects(
    publishAnnouncements({ ...options, entries: [{ ...entry, level: 'important' }] }),
  );
  await assert.rejects(publishAnnouncements({ ...options, entries: [entry, entry] }));
  for (const releaseVersion of ['v2.8.0', '>=2.8.0', '2.8.0/a', 208]) {
    await assert.rejects(
      publishAnnouncements({ ...options, entries: [{ ...entry, releaseVersion }] }),
      /官方公告条目无效/,
    );
  }
  const release = signReleaseIndex(
    {
      schemaVersion: 1,
      kind: 'release-index',
      repository: 'weq-devs/WeQ',
      generatedAt: entry.publishedAt,
      releases: [],
    },
    keys.privateKey,
  );
  assert.throws(() => verifyAnnouncementFeed(release, options.publicKeys), /验签失败/);
});

test('有仓库写权限的贡献者也不能进入公告发布流程', async () => {
  await assert.rejects(
    publishAnnouncements({
      entries: [entry],
      permission: 'WRITE',
      signingKey: () => assert.fail('不能读取密钥'),
      read: async () => assert.fail('不能读取线上发布资产'),
      upload: async () => assert.fail('不能上传'),
    }),
    /只有 WeQ 官方仓库的维护者或管理员/,
  );
});
