import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { releaseKeyId } from '../packages/network/src/release_metadata.mjs';

const keyPath = resolve(
  homedir(),
  'Library/Application Support/WeQ-release/release-metadata-ed25519.pem',
);
mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
if (!existsSync(keyPath)) {
  const { privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    flag: 'wx',
    mode: 0o600,
  });
}
const publicKey = createPublicKey(readFileSync(keyPath))
  .export({ type: 'spki', format: 'pem' })
  .toString();
const destination = resolve(import.meta.dirname, '../packages/network/src/release_keys.json');
const existing = existsSync(destination) ? JSON.parse(readFileSync(destination, 'utf8')) : [];
if (!existing.includes(publicKey))
  writeFileSync(destination, `${JSON.stringify([...existing, publicKey], null, 2)}\n`);
console.log(`发布公钥已准备：${releaseKeyId(publicKey)}；私钥保留在本机发布配置目录。`);
