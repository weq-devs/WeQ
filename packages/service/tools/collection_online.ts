/**
 * 拉取在线收藏夹：注入 QQ → 取 weiyun.com p_skey → collector.weiyun.com 分页拉全。
 *
 * 走与 App 完全相同的 CollectionService.listCollectionsFromNetwork 网络路径
 * (WebCredentialProvider 会顺带 harvest ptlogin2 cookie jar),不碰本地
 * collection.db,输出可读列表 + 类型分布 + 每类一条样例。
 *
 * Run:  pnpm tsx ./packages/service/tools/collection_online.ts [uin] [pageSize]
 *   uin      目标账号(多开时用于挑选进程);省略时取 testEnv.uin
 *   pageSize 每页条数,上限 200,默认 200
 */

import { loadNative } from '@weq/native';
import type { QqPortLoginInfo } from '@weq/native';
import type { AccountSession } from '@weq/account';
import type { CollectionItem } from '@weq/db';
import { CollectionService } from '../src/account/collection';
import { testEnv } from '@weq/testkit';

const TARGET_UIN = process.argv[2] ?? testEnv.uin;
const PAGE_SIZE = Math.max(1, Math.min(Number(process.argv[3] ?? 200) || 200, 200));

function preview(it: CollectionItem): string {
  const s = it.summary;
  if (s.richMediaSummary)
    return s.richMediaSummary.brief || s.richMediaSummary.title || '(rich media)';
  if (s.linkSummary) return `${s.linkSummary.title ?? ''} → ${s.linkSummary.url ?? ''}`;
  if (s.fileSummary) return s.fileSummary.fileInfo?.name ?? '(file)';
  if (s.videoSummary) return `video ${s.videoSummary.title ?? ''}`;
  if (s.audioSummary) return `audio ${s.audioSummary.duration ?? '?'}ms`;
  if (s.locationSummary)
    return `${s.locationSummary.name ?? ''} @${s.locationSummary.latitude ?? '?'},${s.locationSummary.longitude ?? '?'}`;
  if (s.gallerySummary) return `gallery ×${s.gallerySummary.picList?.length ?? 0}`;
  if (s.textSummary) return s.textSummary.text ?? '(text)';
  return '(unknown)';
}

function probeSafe(
  nt: ReturnType<typeof loadNative>['ntHelper'],
  pid: number,
): QqPortLoginInfo | null {
  try {
    return nt.probeQqLoginInfo(pid);
  } catch (e) {
    console.warn(`probeQqLoginInfo(${pid}) 抛错:`, e);
    return null;
  }
}

async function pickPid(nt: ReturnType<typeof loadNative>['ntHelper']): Promise<number> {
  const pids = nt.getQqProcesses();
  console.log(`[online] 运行中的 QQ 进程 pid: ${pids.length ? pids.join(', ') : '(无)'}`);
  if (pids.length === 0) throw new Error('没有运行中的 QQ.exe,请先打开并登录目标账号');

  const probes = pids.map((pid) => ({ pid, info: probeSafe(nt, pid) }));
  for (const { pid, info } of probes) {
    console.log(`  pid=${pid}  uin=${info?.uin || '?'}  loggedIn=${info?.loggedIn ?? '?'}`);
  }

  if (pids.length === 1 && pids[0] !== undefined) return pids[0];
  const match = probes.find((p) => p.info?.uin === TARGET_UIN && p.info?.loggedIn)?.pid;
  if (match === undefined) {
    throw new Error(`多个 QQ 进程,没找到 uin=${TARGET_UIN} 且已登录的进程`);
  }
  return match;
}

async function main(): Promise<void> {
  const nt = loadNative().ntHelper;
  const pid = await pickPid(nt);
  const uin = probeSafe(nt, pid)?.uin ?? TARGET_UIN;
  console.log(`[online] 目标 uin=${uin} pid=${pid}`);

  console.log(`\n[online] 注入 hook 到 pid=${pid} ...`);
  const status = await nt.injectAndGetStatusEmbedded(pid, uin);
  console.log(`[online] 注入结果: pid=${status.pid} uin=${status.uin} loggedIn=${status.loggedIn}`);

  const service = new CollectionService(
    nt,
    { context: { uin } } as unknown as AccountSession,
    () => pid,
  );

  console.log(`\n[online] 从 collector.weiyun.com 分页拉取(每页 ${PAGE_SIZE} 条)...`);
  const all: CollectionItem[] = [];
  let offset = 0;
  for (;;) {
    const page = await service.listCollectionsFromNetwork(PAGE_SIZE, offset);
    if (!page) {
      throw new Error(
        '拿不到 weiyun.com p_skey 或 collector 请求失败(会回退本地 collection.db)。' +
          '请确认 QQ 已登录、已注入,并检查 weiyun.com 凭据。',
      );
    }
    all.push(...page.items);
    console.log(
      `[online] page offset=${page.offset} got=${page.items.length} hasMore=${page.hasMore} source=${page.source}`,
    );
    if (!page.hasMore) break;
    offset += PAGE_SIZE;
  }

  console.log(`\n[online] 在线收藏总数: ${all.length}`);

  console.log('\n[online] 列表(按收藏时间倒序):');
  all.forEach((it, i) => {
    const who = it.author?.strId || it.author?.uid || '?';
    const when = it.collectTime ? new Date(it.collectTime).toLocaleString() : '?';
    console.log(
      `  ${String(i + 1).padStart(4)}. [${it.kind.padEnd(9)}] ${when} by ${who}: ${preview(it).slice(0, 90)}`,
    );
  });

  const dist = new Map<string, number>();
  for (const it of all) dist.set(it.kind, (dist.get(it.kind) ?? 0) + 1);
  console.log('\n[online] 类型分布:');
  [...dist.entries()].sort().forEach(([k, n]) => {
    console.log(`   ${k.padEnd(12)} ${n}`);
  });

  console.log('\n[online] ✅ 在线收藏拉取完成。');
}

main().catch((e) => {
  console.error('\n[online] 失败:', e);
  process.exit(1);
});
