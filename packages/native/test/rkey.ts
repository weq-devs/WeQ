/**
 * 探测脚本:取某个在线 QQ 账号的下载 rkey,打印 fetchDownloadRkeys 的 JSON 结构。
 *
 * rkey 的获取链路和数据库密钥一致:依赖一个已注入 hook 且在线登录的 QQ 进程,
 * 通过 nt_helper 的 OIDB 接口向服务器发包取回。这里只负责:
 *   1. 列出所有 QQ.exe 进程 (getQqProcesses)
 *   2. 用 probeQqLoginInfo 把 pid 归属到具体 uin,找到目标账号的 pid
 *   3. fetchDownloadRkeys(pid) 并打印结果,确认字段形状
 *
 * 用法: pnpm tsx packages/native/test/rkey.ts [uin]
 *   默认 uin = 1707889225(开发账号)。需要该账号的 QQ 正在运行且已登录。
 */

import { loadNative } from '../src/index';
import type { QqPortLoginInfo } from '../src/types';

const TARGET_UIN = process.argv[2] ?? '1707889225';

function probeSafe(
  nt: ReturnType<typeof loadNative>['ntHelper'],
  pid: number,
): QqPortLoginInfo | null {
  try {
    return nt.probeQqLoginInfo(pid);
  } catch (e) {
    console.warn(`[rkey] probeQqLoginInfo(${pid}) 抛错:`, e);
    return null;
  }
}

async function main(): Promise<void> {
  const nt = loadNative().ntHelper;

  const pids = nt.getQqProcesses();
  console.log(`[rkey] 运行中的 QQ 进程 pid: ${pids.length ? pids.join(', ') : '(无)'}`);
  if (pids.length === 0) {
    throw new Error('没有运行中的 QQ.exe,请先打开并登录目标账号');
  }

  // 把每个 pid 归属到 uin / 登录状态。
  const probes = pids.map((pid) => ({ pid, info: probeSafe(nt, pid) }));
  for (const { pid, info } of probes) {
    console.log(
      `[rkey]   pid=${pid}  uin=${info?.uin || '?'}  loggedIn=${info?.loggedIn ?? '?'}  port=${info?.port ?? '?'}`,
    );
  }

  // 选定目标 pid:单进程直接用它;多进程按 uin 匹配。
  let targetPid: number | undefined;
  if (pids.length === 1) {
    targetPid = pids[0];
    console.log(`[rkey] 仅一个 QQ 进程,默认目标 pid=${targetPid}`);
  } else {
    targetPid = probes.find((p) => p.info?.uin === TARGET_UIN && p.info?.loggedIn)?.pid;
    if (targetPid === undefined) {
      throw new Error(
        `多个 QQ 进程,但没有找到 uin=${TARGET_UIN} 且已登录的进程。` +
          `已探测: ${probes.map((p) => `${p.pid}:${p.info?.uin || '?'}`).join(', ')}`,
      );
    }
    console.log(`[rkey] 匹配到 uin=${TARGET_UIN} 的 pid=${targetPid}`);
  }

  // OIDB 接口(取 key / 取 rkey)需要先把 hook 注入目标进程,否则 mojo 控制管道不存在。
  console.log(`\n[rkey] 注入 hook 到 pid=${targetPid} ...`);
  const status = await nt.injectAndGetStatusEmbedded(targetPid);
  console.log(`[rkey] 注入结果: pid=${status.pid} uin=${status.uin} loggedIn=${status.loggedIn}`);

  console.log(`\n[rkey] 调用 fetchDownloadRkeys(${targetPid}) ...`);
  const raw = await nt.fetchDownloadRkeys(targetPid);
  console.log(`\n[rkey] === 原始返回字符串 ===\n${raw}\n`);

  try {
    const parsed = JSON.parse(raw);
    console.log('[rkey] === JSON.parse 后的结构 ===');
    console.dir(parsed, { depth: null });
  } catch {
    console.log('[rkey] 返回不是合法 JSON,见上面的原始字符串');
  }
}

main().catch((e) => {
  console.error('[rkey] 失败:', e);
  process.exit(1);
});
