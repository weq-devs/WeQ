/** 用合成稀疏文件核验密钥扫描的读取上界，不读取 QQ 数据或真实进程内存。 */
import assert from 'node:assert/strict';
import {
  closeSync,
  ftruncateSync,
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
const directory = mkdtempSync(join(tmpdir(), 'weq-native-key-scan-'));
const source = join(directory, 'synthetic.db');
// 不存在的正 PID：必须先完成数据库读取，再由进程打开步骤返回失败。
const pid = 0x7fffffff;
const maxIncreaseKB = 32 * 1024;

function sparseDatabase(bytes) {
  const fd = openSync(source, 'w');
  try {
    writeSync(fd, Buffer.alloc(5120, 0x37));
    ftruncateSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
}

async function checkScan(bytes, progress) {
  sparseDatabase(bytes);
  assert.equal(statSync(source).size, bytes);
  const baselineKB = process.resourceUsage().maxRSS;
  const result = progress
    ? await nt.scanKeyFromDatabaseWithProgress(source, pid, () => {})
    : await nt.scanKeyFromDatabase(source, pid);
  const increaseKB = process.resourceUsage().maxRSS - baselineKB;
  assert.equal(result.success, false);
  assert.match(result.error, new RegExp(`打开进程 ${pid} 失败`));
  console.log(JSON.stringify({ addon, bytes, progress, peakIncreaseKB: increaseKB }));
  assert.ok(
    increaseKB < maxIncreaseKB,
    `密钥扫描仍疑似整库读取（额外峰值 ${increaseKB} KiB），不能用于大库。`,
  );
}

try {
  assert.equal(nt.getInitStatus(), 0, '原生模块初始化失败');
  assert.equal(typeof nt.scanKeyFromDatabaseWithProgress, 'function', '缺少带进度扫描接口');
  await nt.setLogPath(join(directory, 'native.log'));
  // 先用小文件识别旧实现，失败立即停止，绝不让旧实现尝试 20 GiB 分配。
  await checkScan(64 * 1024 * 1024, true);
  await checkScan(64 * 1024 * 1024, false);
  await checkScan(20 * 1024 ** 3, true);
  await checkScan(20 * 1024 ** 3, false);

  sparseDatabase(5119);
  for (const scan of [nt.scanKeyFromDatabase, nt.scanKeyFromDatabaseWithProgress]) {
    const result = await scan(source, pid);
    assert.equal(result.success, false);
    assert.match(result.error, /读取数据库失败/);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
