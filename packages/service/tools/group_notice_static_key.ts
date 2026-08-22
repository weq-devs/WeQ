/**
 * 用手写 pskey/skey/uin 直接验证群公告 CGI(web.qun.qq.com),不注入 QQ。
 *
 * 请求与生产路径 getGroupNotice 完全一致:URL bkn 用 pskey,POST body bkn 用 skey,
 * Cookie 用 uin/skey/p_skey 拼装。直接把服务器返回的原始 JSON dump 出来,
 * 便于区分「凭据过期 / 风控 / 群没公告 / 没权限」。
 *
 * Run:  pnpm tsx ./packages/service/tools/group_notice_static_key.ts <uin> <pskey> <skey> [groupCode]
 * 也可用环境变量 WEQ_GROUP_UIN / WEQ_GROUP_PSKEY / WEQ_GROUP_SKEY / WEQ_GROUP_CODE 传参。
 */

import { computeBkn, cookieHeader, type WebCredential } from '../src/account/web/credential';

interface RawNoticeRet {
  ec?: number;
  em?: string;
  feeds?: Record<string, unknown>;
}
const ENDPOINT = 'https://web.qun.qq.com/cgi-bin/announce/list_announce';
const REFERER = 'https://web.qun.qq.com/mannounce/index.html?_wv=1031&_bid=148';
const DEFAULT_GROUP = '1090396070';

function mask(value: string): string {
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}${'*'.repeat(value.length - 8)}${value.slice(-4)}`;
}

function dumpBody(label: string, text: string): void {
  console.log(`\n=== ${label} ===`);
  console.log(`字节数: ${Buffer.byteLength(text, 'utf8')}`);
  console.log(`--- 原始文本 (前 2000 字符) ---`);
  console.log(text.slice(0, 2000));
}

async function main(): Promise<void> {
  const uin = process.argv[2] ?? process.env.WEQ_GROUP_UIN ?? '';
  const pskey = process.argv[3] ?? process.env.WEQ_GROUP_PSKEY ?? '';
  const skey = process.argv[4] ?? process.env.WEQ_GROUP_SKEY ?? '';
  const groupCode = process.argv[5] ?? process.env.WEQ_GROUP_CODE ?? DEFAULT_GROUP;

  if (!uin || !pskey || !skey) {
    throw new Error('用法: pnpm tsx ./packages/service/tools/group_notice_static_key.ts <uin> <pskey> <skey> [groupCode]');
  }

  const cred: WebCredential = { uin, skey, pskey };
  const urlBkn = computeBkn(pskey || skey);
  const bodyBkn = computeBkn(skey);

  console.log(`[group] uin     = ${uin}`);
  console.log(`[group] pskey   = ${mask(pskey)} (长度 ${pskey.length})`);
  console.log(`[group] skey    = ${mask(skey)} (长度 ${skey.length})`);
  console.log(`[group] group   = ${groupCode}`);
  console.log(`[group] urlBkn  = ${urlBkn} (来自 pskey)`);
  console.log(`[group] bodyBkn = ${bodyBkn} (来自 skey)`);
  console.log(`[group] Cookie  = ${cookieHeader(cred).slice(0, 60)}...(省略)`);
  console.log(`[group] POST ${ENDPOINT}\n`);

  const body = new URLSearchParams({
    qid: groupCode,
    bkn: String(bodyBkn),
    ft: '23',
    s: '-1',
    n: '20',
    i: '1',
    ni: '1',
  }).toString();

  const res = await fetch(`${ENDPOINT}?bkn=${urlBkn}`, {
    method: 'POST',
    headers: {
      Cookie: cookieHeader(cred),
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: REFERER,
    },
    body,
  });

  console.log(`=== HTTP 响应 ===`);
  console.log(`status: ${res.status} ${res.statusText}`);
  res.headers.forEach((v, k) => {
    console.log(`  ${k}: ${v}`);
  });

  const text = await res.text();
  dumpBody('响应文本', text);

  let parsed: RawNoticeRet | null = null;
  try {
    parsed = JSON.parse(text) as RawNoticeRet;
  } catch {
    // fall through to the null check below
  }
  if (!parsed) {
    console.log(`\n!! 返回的不是 JSON —— 可能被网关/风控拦截,或请求参数不对。`);
    process.exit(1);
  }

  console.log(`\n=== 解析结果 ===`);
  console.log(`ec = ${parsed.ec ?? '?'}   em = ${parsed.em ?? ''}`);
  if (parsed.ec !== 0) {
    console.log(`!! cgi 返回错误码 ${parsed.ec}:${parsed.em ?? ''} —— 凭据/参数/权限问题`);
    process.exit(1);
  }

  const feeds = Object.values(parsed.feeds ?? {}) as Array<{
    fid?: string;
    u?: number;
    pubt?: number;
    msg?: { text?: string; pics?: Array<{ id?: string; w?: number; h?: number }> };
    read_num?: number;
  }>;
  console.log(`✅ 成功,公告数: ${feeds.length}`);
  feeds.forEach((feed, i) => {
    const when = feed.pubt ? new Date(feed.pubt * 1000).toLocaleString() : '?';
    const text0 = feed.msg?.text ?? '';
    const pics = feed.msg?.pics?.length ?? 0;
    console.log(
      `  ${String(i + 1).padStart(3)}. [${when}] by ${feed.u ?? '?'} 图${pics} 已读${feed.read_num ?? '?'}: ${text0.slice(0, 90)}`,
    );
  });
}

main().catch((e) => {
  console.error('\n[group] 失败:', e);
  process.exit(1);
});


