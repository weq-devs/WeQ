/**
 * 用 ptlogin2 本地快速登录(pt_login)实测 QQ 空间读链路 —— 全程**不注入 hook**。
 *
 * Linux 下注入有 ptrace 限制(需提权),而 nt_helper 的 pt_login 端口(4301-4310,
 * 奇数 HTTPS)只要 QQ 在线就能拿 skey / 指定域 p_skey。qzone.qq.com 在
 * PT_LOGIN_DOMAINS 内,正好覆盖说说列表 + 评论/点赞读取。
 *
 * 步骤:
 *   1. probe 登录态(probeQqLoginInfo / probePtLoginPort)
 *   2. 裸调 pt_login 拿 qzone.qq.com 的 pskey(验证凭据可得)
 *   3. WebQueryService(底层自动 pt_login 兜底)拉目标空间说说列表
 *   4. 对新加的评论/点赞读取(collectQzoneInteractions)做冒烟:取最近几条
 *      说说的 tid,批量补互动,打印统计 + 第一条详情
 *
 * 用法: pnpm tsx tools/qzone_ptlogin.ts [targetUin]
 *   targetUin 默认本账号 uin(自己的空间)。传好友 uin 可测好友。
 */
import { loadNative } from '@weq/native';
import type { AccountSession } from '@weq/account';
import { WebQueryService, fetchPskeyViaPtLogin, fetchSkeyViaPtLogin } from '../src/account/web';

function mask(s: string): string {
  if (!s) return '(空)';
  return `${s.slice(0, 3)}…${s.slice(-3)} (len=${s.length})`;
}

async function main(): Promise<void> {
  const nt = loadNative().ntHelper;

  const pids = nt.getQqProcesses();
  console.log(`QQ 进程: ${pids.length ? pids.join(', ') : '(无)'}`);
  if (pids.length === 0) throw new Error('没有运行中的 QQ,请先登录');

  // 选已登录进程
  let targetPid = 0;
  let uin = '';
  for (const pid of pids) {
    const info = nt.probeQqLoginInfo(pid);
    console.log(`pid=${pid} uin=${info?.uin ?? '?'} loggedIn=${info?.loggedIn} port=${info?.port}`);
    if (!targetPid && info?.loggedIn && info.uin) {
      targetPid = pid;
      uin = info.uin;
    }
  }
  if (!targetPid) throw new Error('没有已登录的 QQ 进程');
  const selfUin = uin;
  const TARGET = process.argv[2] ?? selfUin;
  console.log(`\n选中 pid=${targetPid} uin=${uin}  target=${TARGET}\n`);

  // ── 2. 裸调 pt_login 拿 qzone 域 pskey / skey(验证凭证可得)──
  console.log('===== [2] pt_login 裸调(qzone.qq.com)=====');
  const probe = nt.probePtLoginPort(targetPid);
  console.log(`probePtLoginPort: success=${probe.success} msg=${probe.msg} port=${probe.port}`);
  if (!probe.success) throw new Error(`pt_login 端口不可用: ${probe.msg}`);

  const skey = await fetchSkeyViaPtLogin(nt, targetPid, selfUin).catch((e: unknown) => {
    console.log(`  skey(pt_login) 失败: ${(e as Error).message}`);
    return '';
  });
  const pskey = await fetchPskeyViaPtLogin(nt, targetPid, selfUin, 'qzone.qq.com').catch(
    (e: unknown) => {
      console.log(`  pskey(qzone.qq.com, pt_login) 失败: ${(e as Error).message}`);
      return '';
    },
  );
  console.log(`skey (pt_login)   = ${mask(skey)}`);
  console.log(`pskey(qzone, pt_login) = ${mask(pskey)}`);

  // ── 3. WebQueryService(自动 pt_login 兜底)──
  console.log('\n===== [3] WebQueryService 拉说说列表 =====');
  // 与其它 tools 相同:session 只喂 context.uin,resolvePid 固定返回在线 pid。
  const web = new WebQueryService(
    nt,
    { context: { uin: selfUin } } as unknown as AccountSession,
    () => targetPid,
  );

  const NUM = 10;
  const list: Array<{ tid: string; time: number; content: string }> = [];
  try {
    const page = await web.getQzoneMsgList(TARGET, 0, NUM);
    console.log(`getQzoneMsgList: total=${page.total} 本页=${page.list.length}`);
    for (const e of page.list) {
      list.push({ tid: e.tid, time: e.time, content: e.content.slice(0, 40) });
    }
  } catch (e) {
    console.log(`getQzoneMsgList 失败: ${(e as Error).message}`);
  }
  console.dir(list, { depth: null });

  // ── 4. 评论/点赞读取冒烟(collectQzoneInteractions)──
  if (list.length === 0) {
    console.log('\n没有拉到说说,跳过互动冒烟。');
    return;
  }
  const targets = list.map((x) => ({ tid: x.tid, time: x.time }));
  console.log(`\n===== [4] 评论/点赞补全(${targets.length} 条说说)=====`);
  try {
    const map = await web.getQzoneInteractions(TARGET, targets);
    let withData = 0;
    for (const [tid, it] of map) {
      const comments = it.comments.length;
      const likes = it.likes.length;
      if (comments || likes) withData += 1;
      console.log(
        `  tid=${tid}  评论=${comments}  点赞=${likes}${comments || likes ? '' : '  (空)'}`,
      );
      // 打印第一条有互动的详情,验证内容/昵称/回复真实可读。
      const sample = it.comments[0];
      if (sample) {
        console.log(
          `    一级评论样例: ${sample.nickname || sample.uin} (${sample.uin}): ${sample.content.slice(0, 60)}` +
            (sample.isReply ? `  [回复 ${sample.replyToNickname || sample.replyToUin}]` : ''),
        );
      }
      const like = it.likes[0];
      if (like) {
        console.log(
          `    点赞样例: ${like.nickname || like.uin} (${like.uin})${like.customItemId ? ` 个性赞=${like.customItemId}` : ''}`,
        );
      }
    }
    console.log(`互动汇总: ${withData}/${targets.length} 条有评论或点赞`);
  } catch (e) {
    console.log(`collectQzoneInteractions 失败: ${(e as Error).message}`);
  }
}

main().catch((e) => {
  console.error('失败:', e);
  process.exit(1);
});
