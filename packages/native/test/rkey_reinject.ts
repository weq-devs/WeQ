/**
 * 测试重复注入和获取 rkey 的行为：
 *   1. 注入 → 获取 rkey
 *   2. 再次注入 → 再次获取 rkey
 *   3. 两次注入分别获取 rkey
 *
 * 前提：只有一个 QQ.exe 进程且已登录。
 *
 * 用法: pnpm tsx packages/native/test/rkey_reinject.ts
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

  // ===== 场景 1: 注入 → 获取 rkey =====
  console.log('--- 场景 1: 第一次注入 + 获取 rkey ---');
  const status1 = await nt.injectAndGetStatusEmbedded(pid);
  console.log(`[inject#1] pid=${status1.pid} uin=${status1.uin} loggedIn=${status1.loggedIn}`);

  const rkey1 = await nt.fetchDownloadRkeys(pid);
  console.log(`[rkey#1] 长度=${rkey1.length} 字符\n`);

  // ===== 场景 2: 再次注入 → 再次获取 rkey =====
  console.log('--- 场景 2: 第二次注入 + 获取 rkey ---');
  const status2 = await nt.injectAndGetStatusEmbedded(pid);
  console.log(`[inject#2] pid=${status2.pid} uin=${status2.uin} loggedIn=${status2.loggedIn}`);

  const rkey2 = await nt.fetchDownloadRkeys(pid);
  console.log(`[rkey#2] 长度=${rkey2.length} 字符\n`);

  // ===== 场景 3: 连续两次注入，然后分别获取 rkey =====
  console.log('--- 场景 3: 连续两次注入 ---');
  const status3a = await nt.injectAndGetStatusEmbedded(pid);
  console.log(`[inject#3a] pid=${status3a.pid} uin=${status3a.uin}`);

  const status3b = await nt.injectAndGetStatusEmbedded(pid);
  console.log(`[inject#3b] pid=${status3b.pid} uin=${status3b.uin}`);

  const rkey3a = await nt.fetchDownloadRkeys(pid);
  console.log(`[rkey#3a] 长度=${rkey3a.length} 字符`);

  const rkey3b = await nt.fetchDownloadRkeys(pid);
  console.log(`[rkey#3b] 长度=${rkey3b.length} 字符\n`);

  // ===== 结果对比 =====
  console.log('--- 结果对比 ---');
  console.log(`rkey1 === rkey2: ${rkey1 === rkey2}`);
  console.log(`rkey2 === rkey3a: ${rkey2 === rkey3a}`);
  console.log(`rkey3a === rkey3b: ${rkey3a === rkey3b}`);

  // 解析并展示第一个 rkey 的结构
  try {
    const parsed = JSON.parse(rkey1);
    console.log('\n--- 第一个 rkey 的结构 ---');
    console.dir(parsed, { depth: null });
  } catch {
    console.log('\n[warn] rkey1 不是有效 JSON');
  }

  console.log('\n✅ 测试完成，所有操作成功');
}

main().catch((e) => {
  console.error('[test] 失败:', e);
  process.exit(1);
});
