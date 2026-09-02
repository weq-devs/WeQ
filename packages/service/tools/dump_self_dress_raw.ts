/**
 * Dump 自己装扮端点(GetNewStyleAppUsing)的**原始 JSON**,用来补 self_dress.ts 的解析。
 *
 * self_dress 的 RawUsingItem 只声明了 appId/itemId/name/img 四个字段,别的一律丢掉 ——
 * 名片的动态视频(SSR 页面里在 extraappinfo.extraInfo.immersiveMaterial)在这个 JSON
 * 端点里叫什么、结构如何,只能实测。所以这里不走 getSelfDress(),直接手发同一个请求,
 * 把整个响应写盘 + 打印每一项的字段名与 appId 15/4/22 三项的完整对象。
 *
 * 用法: pnpm tsx ./packages/service/tools/dump_self_dress_raw.ts
 */

import { writeFileSync } from 'node:fs';
import { loadNative } from '@weq/native';
import { ensureSendable } from '@weq/testkit';
import { computeBkn, cookieHeader, WebCredentialProvider } from '../src/account/web/credential';

const ENDPOINT =
  'https://zb.vip.qq.com/trpc-proxy/qqva/qc_userinfo_server/QcUserinfoServer/GetNewStyleAppUsing';

const QUERY_APP_IDS = [3, 2, 4, 8, 5, 15, 23, 26, 37, 17, 22, 352, 20];

const DRESS_UA =
  'Dalvik/2.1.0 (Linux; U; Android 13; 2109119BC Build/TKQ1.221114.001) V1_AND_SQ_9.3.25_15220_YYB_D QQ/9.3.25.38950 NetType/4G WebP/0.4.1 AppId/537375289';

const OUT = 'tmp/self_dress_raw.json';

/** 递归列出对象里所有字段路径(数组只看第 0 项),用来一眼看出我们漏了什么。 */
function paths(value: unknown, prefix = '', depth = 0, out: string[] = []): string[] {
  if (depth > 6 || value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    if (value.length > 0) paths(value[0], `${prefix}[0]`, depth + 1, out);
    return out;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const p = prefix ? `${prefix}.${k}` : k;
    const t = v === null ? 'null' : Array.isArray(v) ? `array(${v.length})` : typeof v;
    out.push(
      `${p}: ${t}${t === 'string' || t === 'number' || t === 'boolean' ? ` = ${JSON.stringify(v)?.slice(0, 120)}` : ''}`,
    );
    paths(v, p, depth + 1, out);
  }
  return out;
}

async function main(): Promise<void> {
  const nt = loadNative().ntHelper;

  const pids = nt.getQqProcesses();
  if (pids.length === 0) throw new Error('没有运行中的 QQ.exe,请先打开并登录任意账号');
  // QQ 可能有多个进程(登录窗/主窗),pids[0] 未必是登录着的那个 —— 挑出带 uin 的。
  let pid = 0;
  let myUin = '';
  for (const p of pids) {
    const probed = nt.probeQqLoginInfo(p);
    console.log(`[dump-dress] pid=${p} uin=${probed?.uin ?? ''} loggedIn=${probed?.loggedIn}`);
    if (probed?.uin) {
      pid = p;
      myUin = probed.uin;
      break;
    }
  }
  if (!myUin) throw new Error('所有 QQ 进程都 probe 不到 uin');

  await ensureSendable(nt, pid, myUin, { label: 'dump-dress' });

  const creds = new WebCredentialProvider(nt, myUin, () => pid);
  const cred = await creds.forDomain('vip.qq.com');

  const res = await fetch(`${ENDPOINT}?g_tk=${computeBkn(cred.pskey)}`, {
    method: 'POST',
    headers: {
      Cookie: cookieHeader(cred),
      'Content-Type': 'application/json',
      'User-Agent': DRESS_UA,
      Referer: 'https://zb.vip.qq.com/kuikly/category/3760',
    },
    body: JSON.stringify({
      req: { appIds: QUERY_APP_IDS, loginInfo: { opplat: 2, qqVer: '9.3.25' } },
      options: {
        context: { businessType: 'qqgxh' },
        naming: { namespace: 'Production', env: 'formal' },
      },
    }),
  });
  console.log(`[dump-dress] http ${res.status} ${res.statusText}`);
  const text = await res.text();
  writeFileSync(OUT, text, 'utf-8');
  console.log(`[dump-dress] 原始响应已写入 ${OUT} (${text.length} 字节)`);

  const data = JSON.parse(text) as {
    retCode?: number;
    response?: {
      apps?: Record<string, { appId?: number; usingItems?: Record<string, unknown>[] }>;
    };
  };
  console.log(`[dump-dress] retCode=${data.retCode}`);

  // 每个桶里每一项的字段名总览 —— 一眼看出 self_dress 漏了哪些。
  const allKeys = new Set<string>();
  for (const [bucketKey, bucket] of Object.entries(data.response?.apps ?? {})) {
    for (const item of bucket.usingItems ?? []) {
      for (const k of Object.keys(item)) allKeys.add(k);
      console.log(
        `\n---- bucket=${bucketKey} appId=${item.appId} name=${JSON.stringify(item.name)} ----`,
      );
      console.log(`     顶层字段: ${Object.keys(item).join(', ')}`);
    }
  }
  console.log(`\n[dump-dress] 所有项出现过的顶层字段并集: ${[...allKeys].sort().join(', ')}`);

  // 重点三类:挂件(4)/名片(15)/浮屏(22) —— 首页要用的正是这三个,完整摊开。
  for (const want of [4, 15, 22, 17]) {
    for (const bucket of Object.values(data.response?.apps ?? {})) {
      for (const item of bucket.usingItems ?? []) {
        if (item.appId !== want) continue;
        console.log(`\n══════ appId=${want} 完整对象 ══════`);
        console.log(JSON.stringify(item, null, 2));
        console.log(`\n—— 字段路径展开 ——`);
        for (const line of paths(item)) console.log(`  ${line}`);
      }
    }
  }
}

main().catch((e) => {
  console.error('[dump-dress] 失败:', e);
  process.exit(1);
});
