import { createHash, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  signReleaseIndex,
  verifyReleaseIndex,
  type ReleaseIndex,
} from '../src/release_metadata.mjs';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
function fixture(): ReleaseIndex {
  const text = JSON.stringify({ schemaVersion: 1 });
  return {
    schemaVersion: 1,
    kind: 'release-index',
    repository: 'weq-devs/WeQ',
    generatedAt: '2026-11-16T00:00:00Z',
    releases: [
      {
        tag: 'v2.7.2',
        version: '2.7.2',
        prerelease: false,
        publishedAt: '2026-11-15T00:00:00Z',
        assets: [
          {
            name: 'enhancement-packs-darwin-arm64.json',
            size: Buffer.byteLength(text),
            sha256: createHash('sha256').update(text).digest('hex'),
          },
        ],
        catalogs: { 'enhancement-packs-darwin-arm64.json': text },
      },
    ],
  };
}
describe('可经镜像传输的发布身份', () => {
  it('验签保留版本、文件身份及原始描述', () => {
    const index = fixture();
    expect(
      verifyReleaseIndex(signReleaseIndex(index, privatePem), index.repository, [publicPem]),
    ).toEqual(index);
  });
  it('拒绝修改正文、替换签名、错误来源和未知签名者', () => {
    const index = fixture();
    const signed = signReleaseIndex(index, privatePem);
    expect(() =>
      verifyReleaseIndex(
        { ...signed, payload: Buffer.from('{}').toString('base64') },
        index.repository,
        [publicPem],
      ),
    ).toThrow();
    expect(() =>
      verifyReleaseIndex(
        { ...signed, signature: Buffer.alloc(64).toString('base64') },
        index.repository,
        [publicPem],
      ),
    ).toThrow();
    expect(() => verifyReleaseIndex(signed, 'weq-devs/dress-resources', [publicPem])).toThrow();
    expect(() => verifyReleaseIndex(signed, index.repository, [])).toThrow();
  });
  it('签名不能掩盖资产哈希、重复文件或路径错误', () => {
    for (const change of [
      (index: ReleaseIndex) => {
        index.releases[0]!.assets[0]!.sha256 = 'a'.repeat(64);
      },
      (index: ReleaseIndex) => {
        index.releases[0]!.assets.push(index.releases[0]!.assets[0]!);
      },
      (index: ReleaseIndex) => {
        index.releases[0]!.assets[0]!.name = '../file';
      },
    ]) {
      const index = fixture();
      change(index);
      expect(() => signReleaseIndex(index, privatePem)).toThrow();
    }
  });
});
