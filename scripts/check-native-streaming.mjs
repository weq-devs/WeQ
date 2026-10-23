/** 用合成密文核验实际原生产物，不读取 QQ 数据；旧整库双缓冲实现必须失败。 */
import assert from 'node:assert/strict';
import { createHash, createCipheriv, pbkdf2Sync } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const addon = process.argv[2]
  ? resolve(process.argv[2])
  : join(
      resolve(process.env.WEQ_NATIVE_DIR ?? join(root, 'native')),
      process.platform,
      process.arch,
      'nt_helper.node',
    );
const nt = createRequire(import.meta.url)(addon);
const directory = mkdtempSync(join(tmpdir(), 'weq-native-stream-'));
const source = join(directory, 'source.db');
const output = join(directory, 'plain.db');
const pageSize = 4096;
const pages = 16384;
const key = 'weq-stream-decrypt-test';
const salt = Buffer.alloc(16, 0x37);
const iv = Buffer.alloc(16, 0x42);
const encKey = pbkdf2Sync(key, salt, 4000, 32, 'sha512');

function encryptedPage(first) {
  const skip = first ? salt.length : 0;
  const plain = Buffer.alloc(pageSize - skip - 48, 0x11);
  const cipher = createCipheriv('aes-256-cbc', encKey, iv);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const raw = Buffer.alloc(pageSize);
  if (first) salt.copy(raw);
  encrypted.copy(raw, skip);
  iv.copy(raw, skip + encrypted.length);
  const decoded = Buffer.alloc(pageSize);
  plain.copy(decoded, skip);
  if (first) {
    decoded.write('SQLite format 3\0');
    decoded.writeUInt16BE(pageSize, 16);
  }
  return { raw, decoded };
}

try {
  assert.equal(nt.getInitStatus(), 0, '原生模块初始化失败');
  await nt.setLogPath(join(directory, 'native.log'));
  const header = Buffer.alloc(1024);
  header.write('SQLite header 3\0');
  header.write('QQ_NT DB', 32);
  const first = encryptedPage(true);
  const next = encryptedPage(false);
  const expected = createHash('sha256');
  const fd = openSync(source, 'wx');
  try {
    writeSync(fd, header);
    for (let page = 0; page < pages; page += 1) {
      const { raw, decoded } = page === 0 ? first : next;
      writeSync(fd, raw);
      expected.update(decoded);
    }
  } finally {
    closeSync(fd);
  }
  const baselineKB = process.resourceUsage().maxRSS;
  nt.fastDecryptDatabase(source, output, key, {
    pageHmacAlgorithm: 'SHA1',
    kdfHmacAlgorithm: 'SHA512',
  });
  const increaseKB = process.resourceUsage().maxRSS - baselineKB;
  assert.equal(statSync(output).size, pages * pageSize);
  const actual = createHash('sha256');
  for await (const chunk of createReadStream(output)) actual.update(chunk);
  assert.equal(actual.digest('hex'), expected.digest('hex'), '解密内容不匹配');
  console.log(
    JSON.stringify({
      addon,
      bytes: pages * pageSize,
      peakIncreaseKB: increaseKB,
      bytesMatch: true,
    }),
  );
  assert.ok(
    increaseKB < 48 * 1024,
    `原生模块仍疑似整库缓冲（额外峰值 ${increaseKB} KiB），不能用于大库修复。请更新实际加载的 nt_helper.node，不能只更新 WeQ 源码。`,
  );
} finally {
  try {
    nt.closeAllDb();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
