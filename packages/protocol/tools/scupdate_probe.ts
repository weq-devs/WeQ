/**
 * 端到端探测:用 `@weq/protocol` 的 scupdate 模块,把个性装扮 item_id 换成真实下载外链。
 *
 * 与 `scupdate.test.ts`(纯离线单测)互补 —— 这个脚本要真发包,需要目标账号的 QQ
 * 正在运行且已登录。跑通即证明:桌面 NTQQ 能发手Q 独有的 `scupdate.handle` 包并被
 * 服务端受理。
 *
 * 用法:
 *   pnpm tsx packages/protocol/tools/scupdate_probe.ts               # 拉清单 + 抽样换链接
 *   pnpm tsx packages/protocol/tools/scupdate_probe.ts --bubble 2078642
 *   pnpm tsx packages/protocol/tools/scupdate_probe.ts --font 32824
 *   pnpm tsx packages/protocol/tools/scupdate_probe.ts --widget 176016
 *   pnpm tsx packages/protocol/tools/scupdate_probe.ts --all         # 换清单里全部资源
 *   pnpm tsx packages/protocol/tools/scupdate_probe.ts --verify      # 顺带 HTTP 校验外链可下载
 *
 * linux 需 root（ptrace 注入）:
 *   sudo -E node --import tsx packages/protocol/tools/scupdate_probe.ts
 */

import { loadNative } from '@weq/native';
import type { QqPortLoginInfo } from '@weq/native';
import { ensureSendable, testEnv } from '@weq/testkit';
import {
  getBubbleResources,
  getFontResource,
  getPendantResources,
  getUrlsByScid,
  syncResourceList,
  type ResourceUrl,
} from '../src/scupdate';

const argv = process.argv.slice(2);
const has = (f: string): boolean => argv.includes(f);
const opt = (f: string): string | undefined => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

const BUBBLE_ID = opt('--bubble');
const FONT_ID = opt('--font');
const WIDGET_ID = opt('--widget');
const RESOLVE_ALL = has('--all');
const VERIFY = has('--verify');
/** 不换全部时,每类资源抽样换取的条数。 */
const SAMPLE_SIZE = 6;

const CLIENT = { from: 'WeQProbe' } as const;

// ─────────────────────────── 输出 ───────────────────────────

function report(r: ResourceUrl): void {
  if (r.ok) {
    console.log(`  ✅ ${r.scid}`);
    console.log(`       ${r.size} B  ver=${r.version}`);
    console.log(`       ${r.url}`);
    return;
  }
  const why =
    r.reason === 'not-found'
      ? '资源不存在(该 id 不存在或账号未拥有)'
      : r.reason === 'empty-response'
        ? '服务端未返回该条'
        : '该款无此分包';
  console.log(`  ⚪ ${r.scid} — ${why}`);
}

/** HTTP 校验外链确实可下载(无需任何鉴权)。 */
async function verify(r: ResourceUrl): Promise<void> {
  try {
    const resp = await fetch(r.url);
    const buf = new Uint8Array(await resp.arrayBuffer());
    const magic = Array.from(buf.subarray(0, 4), (b) => b.toString(16).padStart(2, '0')).join('');
    const kind = magic.startsWith('504b0304') ? 'ZIP' : magic === '00010000' ? 'TTF' : '';
    console.log(
      `       ↳ HTTP ${resp.status}  实收 ${buf.length} B` +
        `${kind ? `  ${kind}` : ''}${buf.length === r.size ? '  大小吻合' : ''}`,
    );
  } catch (e) {
    console.log(`       ↳ 下载失败: ${e instanceof Error ? e.message : e}`);
  }
}

async function reportAll(items: ResourceUrl[]): Promise<number> {
  let ok = 0;
  for (const r of items) {
    report(r);
    if (r.ok) {
      ok++;
      if (VERIFY) await verify(r);
    }
  }
  return ok;
}

// ─────────────────────────── 目标进程 ───────────────────────────

type Nt = ReturnType<typeof loadNative>['ntHelper'];

function probeSafe(nt: Nt, pid: number): QqPortLoginInfo | null {
  try {
    return nt.probeQqLoginInfo(pid);
  } catch {
    return null;
  }
}

async function resolveTarget(nt: Nt): Promise<number> {
  const pids = nt.getQqProcesses();
  if (pids.length === 0) throw new Error('没有运行中的 QQ.exe,请先打开并登录目标账号');

  let pid = pids[0]!;
  if (pids.length > 1) {
    const hit = pids.find((p) => {
      const info = probeSafe(nt, p);
      return info?.uin === testEnv.uin && info.loggedIn;
    });
    if (hit === undefined) {
      throw new Error(`多个 QQ 进程,但没有 uin=${testEnv.uin} 且已登录的:${pids.join(', ')}`);
    }
    pid = hit;
  }

  const status = await ensureSendable(nt, pid, { label: 'probe' });
  console.log(`[probe] pid=${pid} uin=${status.uin} loggedIn=${status.loggedIn}\n`);
  return pid;
}

// ─────────────────────────── main ───────────────────────────

async function main(): Promise<void> {
  const nt = loadNative().ntHelper;
  const pid = await resolveTarget(nt);

  // ── 指定气泡 ──
  if (BUBBLE_ID) {
    console.log(`── 气泡 ${BUBBLE_ID} ──`);
    const res = await getBubbleResources(nt, pid, BUBBLE_ID, CLIENT);
    const ok = await reportAll(res.all);
    console.log(`\n${ok > 0 ? '✅' : '❌'} 拿到 ${ok}/${res.all.length} 个资源文件`);
    return;
  }

  // ── 指定字体 ──
  if (FONT_ID) {
    console.log(`── 字体 ${FONT_ID} ──`);
    const res = await getFontResource(nt, pid, FONT_ID, CLIENT);
    if (!res) {
      console.log('  ❌ 服务端没有返回任何条目');
      return;
    }
    await reportAll([res]);
    console.log(`\n${res.ok ? '✅ 拿到字体资源' : '❌ 未拿到'}`);
    return;
  }

  // ── 指定挂件 ──
  if (WIDGET_ID) {
    console.log(`── 挂件 ${WIDGET_ID} ──`);
    const res = await getPendantResources(nt, pid, WIDGET_ID, CLIENT);
    const ok = await reportAll(res.all);
    console.log(`\n${ok > 0 ? '✅' : '❌'} 拿到 ${ok}/${res.all.length} 个资源文件`);
    return;
  }

  // ── 默认:拉清单 → 换链接 ──
  console.log('── SyncVCR:拉服务端资源清单 ──');
  const listing = await syncResourceList(nt, pid, CLIENT);
  console.log(`[probe] ${listing.scids.length} 个 scid,polltime=${listing.polltime}s`);
  for (const [business, arr] of [...listing.byBusiness].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`    ${business.padEnd(14)} ${arr.length}`);
  }

  let total = 0;
  let okCount = 0;
  for (const business of ['bubble', 'font', 'pendant']) {
    const arr = listing.byBusiness.get(business);
    if (!arr?.length) {
      console.log(`\n── ${business}:清单里没有(该账号未拥有此类资源)──`);
      continue;
    }
    const pick = RESOLVE_ALL ? arr : arr.slice(0, SAMPLE_SIZE);
    console.log(
      `\n── ${business}:换取 ${pick.length}/${arr.length}` +
        `${RESOLVE_ALL ? '' : ' (加 --all 换全部)'} ──`,
    );
    const results = await getUrlsByScid(nt, pid, pick, CLIENT);
    okCount += await reportAll(results);
    total += results.length;
  }

  console.log('\n════════ 结论 ════════');
  if (okCount > 0) {
    console.log(`✅ 桌面 NTQQ 成功换到 ${okCount}/${total} 个资源的真实下载外链。`);
    console.log('   手Q 独有的 scupdate.handle 在桌面端可用。');
  } else {
    console.log(`❌ ${total} 条都没换到外链 —— 检查账号是否拥有对应装扮。`);
  }
}

main().catch((e) => {
  console.error('[probe] 失败:', e);
  process.exit(1);
});
