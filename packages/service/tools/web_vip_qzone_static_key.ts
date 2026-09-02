/**
 * 用手写 pskey/skey/uin 验证 vip.qq.com 与 qzone.qq.com 两个域的 web 接口,不注入 QQ。
 *
 * vip.qq.com 域(实际打 zb.vip.qq.com):
 *   - 自己的装扮   GetNewStyleAppUsing         (self_dress.ts)
 *   - 好友装扮页   v2/pages/aioDressPage       (friend_dress.ts)
 *   - 商城排行榜   trpc-proxy/.../GetItemLikeRank (dress_mall.ts)
 * qzone.qq.com 域:
 *   - 群相册列表   h5.qzone.qq.com/.../qun_list_album_v2   (group_album.ts)
 *   - 空间说说     user.qzone.qq.com/.../emotion_cgi_msglist_v6 (qzone.ts)
 *   - 好友动态     h5.qzone.qq.com/.../feeds3_html_more    (qzone.ts)
 *
 * 每个测试独立 try/catch,单个失败不影响其它,便于逐域核对凭据。
 * 注意:p_skey 是分域的 —— vip.qq.com 和 qzone.qq.com 各要各的 p_skey,
 * 只贴一个域的值,另一个域会以鉴权错误收场(这本身就是验证信息)。
 *
 * Run:  pnpm tsx ./packages/service/tools/web_vip_qzone_static_key.ts <uin> <pskey> <skey> [targetUin] [groupCode]
 * 也可用环境变量 WEQ_WEB_UIN / WEQ_WEB_PSKEY / WEQ_WEB_SKEY / WEQ_WEB_TARGET_UIN / WEQ_WEB_GROUP_CODE。
 */

import type { WebCredential } from '../src/account/web/credential';
import { getSelfDress } from '../src/account/web/self_dress';
import { getFriendDress } from '../src/account/web/friend_dress';
import { getDressRank, DressAppId } from '../src/account/web/dress_mall';
import { getGroupAlbumList } from '../src/account/web/group_album';
import { getQzoneMsgList, getQzoneFeeds } from '../src/account/web/qzone';

const DEFAULT_GROUP = '1090396070';

function mask(value: string): string {
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}${'*'.repeat(value.length - 8)}${value.slice(-4)}`;
}

function section(title: string): void {
  console.log(`\n===== ${title} =====`);
}

async function run<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  console.log(`\n--- ${name} ---`);
  try {
    const value = await fn();
    console.log(`✅ 成功`);
    return value;
  } catch (error) {
    console.log(`❌ 失败: ${(error as Error).message}`);
    return undefined;
  }
}

async function main(): Promise<void> {
  const uin = process.argv[2] ?? process.env.WEQ_WEB_UIN ?? '';
  const pskey = process.argv[3] ?? process.env.WEQ_WEB_PSKEY ?? '';
  const skey = process.argv[4] ?? process.env.WEQ_WEB_SKEY ?? '';
  const targetUin = process.argv[5] ?? process.env.WEQ_WEB_TARGET_UIN ?? uin;
  const groupCode = process.argv[6] ?? process.env.WEQ_WEB_GROUP_CODE ?? DEFAULT_GROUP;

  if (!uin || !pskey || !skey) {
    throw new Error(
      '用法: pnpm tsx ./packages/service/tools/web_vip_qzone_static_key.ts <uin> <pskey> <skey> [targetUin] [groupCode]',
    );
  }

  const cred: WebCredential = { uin, skey, pskey };
  console.log(`[web] uin     = ${uin}`);
  console.log(`[web] pskey   = ${mask(pskey)} (长度 ${pskey.length})`);
  console.log(`[web] skey    = ${mask(skey)} (长度 ${skey.length})`);
  console.log(`[web] targetUin = ${targetUin}`);
  console.log(`[web] groupCode = ${groupCode}`);
  console.log(`[web] 注:p_skey 分域,vip.qq.com / qzone.qq.com 各要各的值。\n`);

  section('vip.qq.com 域 (zb.vip.qq.com)');

  const selfDress = await run('自己的装扮 GetNewStyleAppUsing', () => getSelfDress(cred));
  if (selfDress) {
    console.log(`  装扮项: ${selfDress.items.length}`);
    for (const it of selfDress.items.slice(0, 15)) {
      console.log(`    [${it.kind}] ${it.name} (itemId=${it.itemId})`);
    }
  }

  const friendDress = await run(`好友装扮 aioDressPage (target=${targetUin})`, () =>
    getFriendDress(cred, targetUin),
  );
  if (friendDress) {
    console.log(`  isSvip=${friendDress.isSvip} 装扮项: ${friendDress.items.length}`);
    for (const it of friendDress.items.slice(0, 15)) {
      console.log(`    [${it.kind}] ${it.name}`);
    }
  } else if (friendDress === null) {
    console.log(`  返回 null(页面没解析出数据 —— 未登录态/风控/页面改版)`);
  }

  const rank = await run('商城排行榜 GetItemLikeRank (Bubble)', () =>
    getDressRank(cred, { appId: DressAppId.Bubble, pageSize: 10 }),
  );
  if (rank) {
    console.log(`  排行条数: ${rank.length}`);
    for (const it of rank.slice(0, 10)) {
      console.log(`    ${it.name} (itemId=${it.itemId})`);
    }
  }

  section('qzone.qq.com 域');

  const albums = await run(`群相册列表 qun_list_album_v2 (group=${groupCode})`, () =>
    getGroupAlbumList(cred, groupCode),
  );
  if (albums) {
    console.log(`  相册数: ${albums.length}`);
    for (const a of albums.slice(0, 10)) {
      console.log(`    ${a.title} (${a.photoCount} 张)`);
    }
  }

  const msgList = await run(`空间说说 emotion_cgi_msglist_v6 (target=${targetUin})`, () =>
    getQzoneMsgList(cred, targetUin, 0, 10),
  );
  if (msgList) {
    console.log(`  说说总数: ${msgList.total},本页 ${msgList.list.length} 条`);
    for (const m of msgList.list.slice(0, 10)) {
      console.log(
        `    ${m.time ? new Date(m.time * 1000).toLocaleString() : '?'}: ${m.content.slice(0, 60)}`,
      );
    }
  }

  const feeds = await run('好友动态 feeds3_html_more (self)', () => getQzoneFeeds(cred, uin, 1, 5));
  if (feeds) {
    console.log(`  动态数: ${feeds.feeds.length},hasMore=${feeds.hasMore}`);
    for (const f of feeds.feeds.slice(0, 5)) {
      console.log(
        `    ${f.nickname} (${f.uin}): ${f.html
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 60)}`,
      );
    }
  }

  console.log(`\n===== 验证完成 =====`);
}

main().catch((e) => {
  console.error('\n[web] 失败:', e);
  process.exit(1);
});
