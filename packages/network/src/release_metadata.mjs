import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

export const FEED_TAG = 'weq-update-feed';
export const FEED_ASSET = 'update-index.json';
export const RELEASE_SUMMARY_MAX_CHARS = 300;
const DOMAIN = Buffer.from('WeQ release metadata v1\0');
export function releaseKeyId(key) {
  return createHash('sha256')
    .update(createPublicKey(key).export({ type: 'spki', format: 'der' }))
    .digest('hex');
}
function assetName(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}
export function validateReleaseIndex(value, repository) {
  if (
    value?.schemaVersion !== 1 ||
    value.kind !== 'release-index' ||
    value.repository !== repository ||
    !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
    !Number.isFinite(Date.parse(value.generatedAt)) ||
    !Array.isArray(value.releases) ||
    value.releases.length > 2
  )
    throw new Error('发布索引格式或来源无效');
  const channels = new Set();
  for (const release of value.releases) {
    if (
      !release ||
      !assetName(release.tag) ||
      release.tag === FEED_TAG ||
      typeof release.prerelease !== 'boolean' ||
      channels.has(release.prerelease) ||
      !Number.isFinite(Date.parse(release.publishedAt)) ||
      (release.summary !== undefined &&
        (typeof release.summary !== 'string' ||
          !release.summary.trim() ||
          release.summary.length > RELEASE_SUMMARY_MAX_CHARS ||
          /[\r\n]/.test(release.summary))) ||
      !Array.isArray(release.assets) ||
      !release.assets.length ||
      release.assets.length > 128 ||
      (release.version !== null &&
        (typeof release.version !== 'string' ||
          !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(release.version)))
    )
      throw new Error('发布记录格式无效');
    channels.add(release.prerelease);
    const names = new Set();
    for (const asset of release.assets) {
      if (
        !assetName(asset?.name) ||
        names.has(asset.name) ||
        !Number.isSafeInteger(asset.size) ||
        asset.size <= 0 ||
        !/^[a-f0-9]{64}$/.test(asset.sha256 ?? '')
      )
        throw new Error('发布资产身份无效');
      names.add(asset.name);
    }
    if (
      !release.catalogs ||
      typeof release.catalogs !== 'object' ||
      Array.isArray(release.catalogs)
    )
      throw new Error('发布资源描述无效');
    for (const [name, text] of Object.entries(release.catalogs)) {
      const asset = release.assets.find((item) => item.name === name);
      if (
        !asset ||
        typeof text !== 'string' ||
        Buffer.byteLength(text) !== asset.size ||
        createHash('sha256').update(text).digest('hex') !== asset.sha256
      )
        throw new Error('发布资源描述与资产身份不一致');
      if (name.endsWith('.json')) JSON.parse(text);
    }
  }
  return value;
}
export function signReleaseIndex(index, privateKey) {
  validateReleaseIndex(index, index.repository);
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('发布签名需要 Ed25519 密钥');
  const payload = Buffer.from(JSON.stringify(index));
  return {
    schemaVersion: 1,
    keyId: releaseKeyId(key),
    payload: payload.toString('base64'),
    signature: sign(null, Buffer.concat([DOMAIN, payload]), key).toString('base64'),
  };
}
export function verifyReleaseIndex(envelope, repository, publicKeys) {
  if (
    envelope?.schemaVersion !== 1 ||
    typeof envelope.payload !== 'string' ||
    envelope.payload.length > 12 * 1024 ** 2 ||
    typeof envelope.signature !== 'string'
  )
    throw new Error('发布签名描述无效');
  const payload = Buffer.from(envelope.payload, 'base64');
  const signature = Buffer.from(envelope.signature, 'base64');
  if (
    payload.toString('base64') !== envelope.payload ||
    signature.length !== 64 ||
    signature.toString('base64') !== envelope.signature
  )
    throw new Error('发布签名编码无效');
  const publicKey = publicKeys.find((key) => releaseKeyId(key) === envelope.keyId);
  if (!publicKey || !verify(null, Buffer.concat([DOMAIN, payload]), publicKey, signature))
    throw new Error('发布元数据验签失败');
  return validateReleaseIndex(JSON.parse(payload.toString('utf8')), repository);
}
