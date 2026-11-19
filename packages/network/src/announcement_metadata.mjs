import { createPrivateKey, sign, verify } from 'node:crypto';
import semver from 'semver';
import { FEED_TAG, releaseKeyId } from './release_metadata.mjs';

export const ANNOUNCEMENT_REPOSITORY = 'weq-devs/WeQ';
export const ANNOUNCEMENT_ASSET = 'announcements-v1.json';
export const ANNOUNCEMENT_URL = `https://github.com/${ANNOUNCEMENT_REPOSITORY}/releases/download/${FEED_TAG}/${ANNOUNCEMENT_ASSET}`;
export const MAX_ANNOUNCEMENT_BYTES = 1024 * 1024;
export const MAX_ANNOUNCEMENTS = 100;
export const ANNOUNCEMENT_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
export const announcementReleaseUrl = (version) =>
  `https://github.com/${ANNOUNCEMENT_REPOSITORY}/releases/tag/v${encodeURIComponent(version)}`;
const DOMAIN = Buffer.from('WeQ official announcements v1\0');
const PLATFORMS = new Set(['macos', 'windows', 'linux', 'web']);
const date = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value))
    return NaN;
  const parsed = Date.parse(value);
  const canonical = value.includes('.') ? value : value.replace('Z', '.000Z');
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === canonical ? parsed : NaN;
};
const text = (value, limit) =>
  typeof value === 'string' && value.length <= limit && value.trim().length > 0;

export function validateAnnouncementFeed(feed) {
  if (
    feed?.schemaVersion !== 1 ||
    feed.kind !== 'official-announcements' ||
    feed.repository !== ANNOUNCEMENT_REPOSITORY ||
    !Number.isSafeInteger(feed.revision) ||
    feed.revision < 1 ||
    !Array.isArray(feed.entries) ||
    feed.entries.length > MAX_ANNOUNCEMENTS
  )
    throw new Error('官方公告清单格式无效');
  const ids = new Set();
  for (const entry of feed.entries) {
    if (
      typeof entry?.id !== 'string' ||
      !ANNOUNCEMENT_ID.test(entry.id) ||
      ids.has(entry.id) ||
      !text(entry.title, 120) ||
      !text(entry.body, 16000) ||
      !Number.isFinite(date(entry.publishedAt)) ||
      !['normal', 'important'].includes(entry.level) ||
      (entry.level === 'important'
        ? !(date(entry.remindUntil) > date(entry.publishedAt))
        : entry.remindUntil !== undefined) ||
      (entry.platforms !== undefined &&
        (!Array.isArray(entry.platforms) ||
          !entry.platforms.length ||
          new Set(entry.platforms).size !== entry.platforms.length ||
          !entry.platforms.every((platform) => PLATFORMS.has(platform)))) ||
      (entry.versionRange !== undefined &&
        (!text(entry.versionRange, 120) || semver.validRange(entry.versionRange) === null)) ||
      (entry.releaseVersion !== undefined &&
        (typeof entry.releaseVersion !== 'string' ||
          semver.valid(entry.releaseVersion) !== entry.releaseVersion))
    )
      throw new Error(`官方公告条目无效：${typeof entry?.id === 'string' ? entry.id : '缺少 ID'}`);
    ids.add(entry.id);
  }
  return feed;
}

export function signAnnouncementFeed(feed, privateKey) {
  validateAnnouncementFeed(feed);
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('官方公告需要 Ed25519 签名');
  const payload = Buffer.from(JSON.stringify(feed));
  const envelope = {
    schemaVersion: 1,
    keyId: releaseKeyId(key),
    payload: payload.toString('base64'),
    signature: sign(null, Buffer.concat([DOMAIN, payload]), key).toString('base64'),
  };
  if (Buffer.byteLength(JSON.stringify(envelope)) > MAX_ANNOUNCEMENT_BYTES)
    throw new Error('官方公告签名清单超过 1 MiB');
  return envelope;
}

export function verifyAnnouncementFeed(envelope, publicKeys) {
  if (
    envelope?.schemaVersion !== 1 ||
    typeof envelope.payload !== 'string' ||
    envelope.payload.length > MAX_ANNOUNCEMENT_BYTES ||
    typeof envelope.signature !== 'string' ||
    envelope.signature.length !== 88
  )
    throw new Error('官方公告签名描述无效');
  const payload = Buffer.from(envelope.payload, 'base64');
  const signature = Buffer.from(envelope.signature, 'base64');
  const key = publicKeys.find((publicKey) => releaseKeyId(publicKey) === envelope.keyId);
  if (
    !key ||
    payload.toString('base64') !== envelope.payload ||
    signature.length !== 64 ||
    signature.toString('base64') !== envelope.signature ||
    !verify(null, Buffer.concat([DOMAIN, payload]), key, signature)
  )
    throw new Error('官方公告验签失败');
  return validateAnnouncementFeed(JSON.parse(payload.toString('utf8')));
}
