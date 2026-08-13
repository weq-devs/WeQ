import { loadNative } from './packages/native/src/index.ts';
import path from 'path';
import { createHash } from 'crypto';
import { readdirSync, openSync, readSync, closeSync } from 'fs';

const dir = path.join('D:', 'estkim', 'com.tencent.mobileqq', 'databases', 'nt_db', 'nt_qq_2472b5970cc3e5c0348c9601425e4186');
const dbPath = path.join(dir, 'nt_msg.db');

// 1. 从 gpro_v1-6_<uid>.db 文件名提取 uid
function getUid(dir) {
  for (const name of readdirSync(dir)) {
    const m = /^gpro_v[\d-]+_(u_[A-Za-z0-9_-]+)\.db$/.exec(name);
    if (m?.[1]) return m[1];
  }
  throw new Error('找不到 gpro_v1-6_<uid>.db');
}

// 2. 从 nt_msg.db 头部读取 8 字节 rand
function getHeaderRand(dbPath) {
  const buf = Buffer.alloc(1024);
  const fd = openSync(dbPath, 'r');
  try {
    readSync(fd, buf, 0, 1024, 0);
  } finally {
    closeSync(fd);
  }
  const magicAt = buf.indexOf('QQ_NT DB', 0, 'ascii');
  if (magicAt < 0) throw new Error('找不到 QQ_NT DB 魔数');
  const ascii = [...buf]
    .map((b) => (b >= 0x21 && b < 0x7f ? String.fromCharCode(b) : '\0'))
    .join('');
  for (const m of ascii.slice(magicAt + 8).matchAll(/[\x21-\x7e]+/g)) {
    if (m[0].length === 8) return m[0];
  }
  throw new Error('找不到 8 字节 rand');
}

const uid = getUid(dir);
const rand = getHeaderRand(dbPath);
const md5hex = (s) => createHash('md5').update(s).digest('hex');
const key = md5hex(md5hex(uid) + rand);

console.log('安卓数据库目录:', dir);
console.log('uid:', uid);
console.log('rand:', rand);
console.log('计算出的密钥:', key);
console.log('数据库路径:', dbPath);

const bundle = loadNative();
const nt = bundle.ntHelper;

// 探测算法
console.log('\n探测数据库算法...');
const probe = await nt.testDatabaseKey(dbPath, key);
console.log('探测结果:', probe);

if (!probe.success) {
  console.error('密钥验证失败！');
  process.exit(1);
}

const algo = {
  pageHmacAlgorithm: probe.pageHmacAlgorithm,
  kdfHmacAlgorithm: probe.kdfHmacAlgorithm,
};
console.log('使用算法:', algo);

console.log('=== 1. 检查 service_assistant_contact 表 ===');
try {
  const serviceRows = await nt.executeSqlWithKey(dbPath, 'SELECT "41102","40094","41110","40050","40001" FROM service_assistant_contact', key, algo, []);
  console.log('服务号联系人数量:', serviceRows.length);
  serviceRows.forEach((row, i) => {
    console.log('');
    console.log('[服务号', (i+1) + ']');
    console.log('  appId (41102):', row[0]);
    console.log('  displayName (40094):', row[1]);
    console.log('  avatarUrl (41110):', row[2]);
    console.log('  lastTime (40050):', row[3]);
    console.log('  lastMsgId (40001):', row[4]);
  });
} catch (e) {
  console.log('查询失败:', e.message);
}

console.log('\n=== 2. 检查 recent_contact_v3_table 中的 chatType=103 (公众号) ===');
try {
  const officialRows = await nt.executeSqlWithKey(dbPath, 'SELECT "40011","40010","40027" FROM recent_contact_v3_table WHERE "40010" = 103 LIMIT 10', key, algo, []);
  console.log('公众号联系人数量:', officialRows.length);
  officialRows.forEach((row, i) => {
    console.log('');
    console.log('[公众号', (i+1) + ']');
    console.log('  targetUid (40011):', row[0]);
    console.log('  chatType (40010):', row[1]);
    console.log('  targetUin (40027):', row[2]);
  });
} catch (e) {
  console.log('查询失败:', e.message);
}

console.log('\n完成，关闭数据库连接');
nt.closeDb(dbPath);

// === 3. 检查服务号的消息表 ===
console.log('\n\n=== 3. 检查服务号消息（service_assistant_msg_table）===');
try {
  // 查询 QQ会员 (appId=102761677) 的最新消息
  const msg1 = await nt.executeSqlWithKey(
    dbPath,
    'SELECT "40001","40800","40035","40050" FROM service_assistant_msg_table WHERE "40035" = ? ORDER BY "40050" DESC LIMIT 1',
    key,
    algo,
    [102761677n]
  );
  console.log('\nQQ会员 最新消息:');
  if (msg1.length > 0) {
    console.log('  msgId (40001):', msg1[0][0]);
    console.log('  msgBody (40800):', msg1[0][1] instanceof Uint8Array ? `BLOB ${msg1[0][1].length} bytes` : msg1[0][1]);
    console.log('  appId (40035):', msg1[0][2]);
    console.log('  sendTime (40050):', msg1[0][3]);
  } else {
    console.log('  无消息');
  }

  // 查询 功能内测通知 (appId=102810742) 的最新消息
  const msg2 = await nt.executeSqlWithKey(
    dbPath,
    'SELECT "40001","40800","40035","40050" FROM service_assistant_msg_table WHERE "40035" = ? ORDER BY "40050" DESC LIMIT 1',
    key,
    algo,
    [102810742n]
  );
  console.log('\n功能内测通知 最新消息:');
  if (msg2.length > 0) {
    console.log('  msgId (40001):', msg2[0][0]);
    console.log('  msgBody (40800):', msg2[0][1] instanceof Uint8Array ? `BLOB ${msg2[0][1].length} bytes` : msg2[0][1]);
    console.log('  appId (40035):', msg2[0][2]);
    console.log('  sendTime (40050):', msg2[0][3]);
  } else {
    console.log('  无消息');
  }
} catch (e) {
  console.log('查询失败:', e.message);
}

// === 4. 解析服务号消息的 elements ===
console.log('\n\n=== 4. 检查服务号消息是否有 ARK 元素 ===');
console.log('提示：需要手动解析 protobuf，暂时直接查看原始 BLOB 的前 200 bytes');
try {
  const msg1 = await nt.executeSqlWithKey(
    dbPath,
    'SELECT "40001","40800" FROM service_assistant_msg_table WHERE "40035" = ? ORDER BY "40050" DESC LIMIT 1',
    key,
    algo,
    [102761677n]
  );

  if (msg1.length > 0 && msg1[0][1] instanceof Uint8Array) {
    console.log('\nQQ会员 msgBody 分析:');
    const msgBody = msg1[0][1];
    const hex = Buffer.from(msgBody).toString('hex');
    console.log('  总长度:', msgBody.length, 'bytes');
    console.log('  前 300 bytes (hex):\n   ', hex.slice(0, 600));

    // 搜索 elementType tag (45002 = d0fd15 in protobuf)
    console.log('\n  是否包含 elementType tag (d0fd15):', hex.includes('d0fd15'));

    // 搜索 ARK 相关字段
    const str = Buffer.from(msgBody).toString('utf8');
    console.log('  是否包含 "prompt":', str.includes('prompt'));
    console.log('  是否包含 "view":', str.includes('view'));
    console.log('  是否包含 "com.tencent":', str.includes('com.tencent'));

    // 尝试找到 elementType=10 的位置
    const elementTypePattern = 'd0fd150a'; // tag d0fd15 + varint 10 (0x0a)
    console.log('  是否包含 elementType=10 (d0fd150a):', hex.includes(elementTypePattern));
  }

  const msg2 = await nt.executeSqlWithKey(
    dbPath,
    'SELECT "40001","40800" FROM service_assistant_msg_table WHERE "40035" = ? ORDER BY "40050" DESC LIMIT 1',
    key,
    algo,
    [102810742n]
  );

  if (msg2.length > 0 && msg2[0][1] instanceof Uint8Array) {
    console.log('\n功能内测通知 msgBody 分析:');
    const msgBody = msg2[0][1];
    const hex = Buffer.from(msgBody).toString('hex');
    console.log('  总长度:', msgBody.length, 'bytes');
    console.log('  前 300 bytes (hex):\n   ', hex.slice(0, 600));

    console.log('\n  是否包含 elementType tag (d0fd15):', hex.includes('d0fd15'));

    const str = Buffer.from(msgBody).toString('utf8');
    console.log('  是否包含 "prompt":', str.includes('prompt'));
    console.log('  是否包含 "view":', str.includes('view'));

    const elementTypePattern = 'd0fd150a';
    console.log('  是否包含 elementType=10 (d0fd150a):', hex.includes(elementTypePattern));
  }
} catch (e) {
  console.log('解析失败:', e.message);
}
