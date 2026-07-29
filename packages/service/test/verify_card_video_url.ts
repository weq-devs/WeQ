/**
 * 验证「名片视频 url = 预览图同目录 newPreview2.mp4」这个猜测。
 *
 * self_dress(JSON 端点)每项只回 appId/itemId/img/name,没有视频字段;但 friend_dress
 * (SSR 页面)对名片(appId 15)有**权威**的 extraInfo.immersiveMaterial.videoUrl。名片
 * 不在 friend_dress 的剔除名单里(那只剔气泡2/字体5/头像23),所以查自己的 uin 就能拿到
 * 真值,拿它和猜测出来的 url 比 —— 相等才说明这条推导规则站得住。
 *
 * 用法: pnpm tsx ./packages/service/test/verify_card_video_url.ts
 */

import { loadNative } from '@weq/native';
import { ensureSendable } from '@weq/testkit';
import { WebCredentialProvider } from '../src/account/web/credential';
import { getFriendDress } from '../src/account/web/friend_dress';
import { getSelfDress } from '../src/account/web/self_dress';

/** 待验证的推导规则:预览图 → 视频 url。 */
function guessVideoUrl(img: string): string | null {
  const m = img.match(/^(.*\/)newPreview\d+\.(?:jpg|png)$/);
  return m ? `${m[1]}newPreview2.mp4` : null;
}

async function main(): Promise<void> {
  const nt = loadNative().ntHelper;

  let pid = 0;
  let myUin = '';
  for (const p of nt.getQqProcesses()) {
    const probed = nt.probeQqLoginInfo(p);
    if (probed?.uin) {
      pid = p;
      myUin = probed.uin;
      break;
    }
  }
  if (!myUin) throw new Error('没有已登录的 QQ 进程');
  console.log(`[card-video] pid=${pid} uin=${myUin}`);

  await ensureSendable(nt, pid, { label: 'card-video' });

  const creds = new WebCredentialProvider(nt, myUin, () => pid);
  const cred = await creds.forDomain('vip.qq.com');

  // 1) self_dress:拿到名片的预览图 → 推导视频 url
  const self = await getSelfDress(cred);
  const selfCard = self.items.find((i) => i.appId === 15);
  console.log(`\n[card-video] self_dress 名片: ${selfCard?.name} img=${selfCard?.previewUrl}`);
  const guessed = selfCard ? guessVideoUrl(selfCard.previewUrl) : null;
  console.log(`[card-video] 推导出的视频 url: ${guessed ?? '(推不出)'}`);

  // 2) friend_dress:同一个名片的权威 videoUrl
  const friend = await getFriendDress(cred, myUin);
  if (!friend) {
    console.log('[card-video] friend_dress 解析失败(拿不到权威值,无法验证)');
    return;
  }
  const friendCard = friend.items.find((i) => i.appId === 15);
  console.log(`\n[card-video] friend_dress 名片: ${friendCard?.name} itemId=${friendCard?.itemId}`);
  console.log(`[card-video] 权威 videoUrl: ${friendCard?.videoUrl ?? '(该字段为空)'}`);

  // 3) 比对
  console.log('');
  if (!friendCard?.videoUrl) {
    console.log('[card-video] ⚠ 权威字段为空 —— 说明这张名片可能本来就没有视频,或 SSR 页面没带');
  } else if (guessed === friendCard.videoUrl) {
    console.log('[card-video] ✅ 推导规则与权威值完全一致');
  } else {
    console.log('[card-video] ❌ 不一致!');
    console.log(`  推导: ${guessed}`);
    console.log(`  权威: ${friendCard.videoUrl}`);
  }

  // 顺带把 friend_dress 里所有带 videoUrl 的项列出来,看还有哪些类别有动态资源。
  console.log('\n[card-video] friend_dress 全部项(带视频的标 ★):');
  for (const i of friend.items) {
    console.log(
      `  ${i.videoUrl ? '★' : ' '} appId=${i.appId} ${i.kind} ${i.name}\n      img=${i.previewUrl}${i.videoUrl ? `\n      video=${i.videoUrl}` : ''}`,
    );
  }
}

main().catch((e) => {
  console.error('[card-video] 失败:', e);
  process.exit(1);
});
