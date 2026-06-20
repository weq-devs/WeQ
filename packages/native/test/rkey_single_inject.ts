/**
 * 测试当前逻辑：注入一次，多次获取 rkey
 *   1. 注入一次
 *   2. 第一次获取 rkey
 *   3. 第二次获取 rkey
 *
 * 验证注入后多次调用 fetchDownloadRkeys 是否都能成功。
 *
 * 前提：只有一个 QQ.exe 进程且已登录。
 *
 * 用法: pnpm tsx packages/native/test/rkey_single_inject.ts
 */

import { loadNative } from '../src/index';

async function main(): Promise<void> {
  const nt = loadNative().ntHelper;

  // 获取唯一的 QQ 进程
  const pids = nt.getQqProcesses();
  console.log(`[test] 运行中的 QQ 进程: ${pids.length ? pids.join(', ') : '(无)'}`);
  if (pids.length === 0) {
    throw new Error('没有运行中的 QQ.exe');
  }
  const pid = pids[0]!;
  console.log(`[test] 使用 pid=${pid}\n`);

  // 注入一次
  console.log('--- 注入 hook ---');
  const status = await nt.injectAndGetStatusEmbedded(pid);
  console.log(`[inject] pid=${status.pid} uin=${status.uin} loggedIn=${status.loggedIn}\n`);

  // 第一次获取 rkey
  console.log('--- 第一次获取 rkey ---');
  const rkey1 = await nt.fetchDownloadRkeys(pid);
  console.log(`[rkey#1] 长度=${rkey1.length} 字符\n`);

  // 第二次获取 rkey（不再注入）
  console.log('--- 第二次获取 rkey（不再注入）---');
  const rkey2 = await nt.fetchDownloadRkeys(pid);
  console.log(`[rkey#2] 长度=${rkey2.length} 字符\n`);

  // 结果对比
  console.log('--- 结果对比 ---');
  console.log(`rkey1 === rkey2: ${rkey1 === rkey2}`);
  console.log(`两次获取的内容${rkey1 === rkey2 ? '完全相同' : '不同'}`);

  // 解析并展示结构
  try {
    const parsed = JSON.parse(rkey1);
    console.log('\n--- rkey 结构 ---');
    console.dir(parsed, { depth: null });
  } catch {
    console.log('\n[warn] rkey 不是有效 JSON');
  }

  console.log('\n✅ 测试完成，注入一次后多次获取均成功');
}

main().catch((e) => {
  console.error('[test] 失败:', e);
  process.exit(1);
});
