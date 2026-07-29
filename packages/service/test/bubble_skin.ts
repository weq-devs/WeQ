/**
 * 气泡九宫格解析的离线校验。
 *
 * 不需要 QQ 在线 —— immersive 外链是公开的(鉴权只发生在商城接口那边),所以这个脚本
 * 直接打 CDN,把 {@link resolveBubbleSkin} 的输出与手工实测值逐项比对。
 *
 * 覆盖两条路径,因为**外链推不出来**(详见 bubble_skin 模块头):
 *
 *  - **老式路径**(目录段就是 itemId):只给 staticUrl,让解析层自己探拉伸点/动效/文字色。
 *    四款样本是特意挑的 —— 2078642 上下恰好对称(唯一能被 `width/2` 蒙对的),其余三款
 *    都不对称;2130704 的填充图全透明(文字色必须降级到主题色);2072805/2130704 无动效。
 *  - **material 路径**(新款 hash 目录):从 `resources/dress/ranking-bubble.json` 里取真实
 *    material 喂进去。这是回归用例 —— 这些款按 itemId 拼 url 一律 404,曾经全军覆没。
 *
 * 用法: pnpm tsx ./packages/service/test/bubble_skin.ts
 */

import { readFileSync } from 'node:fs';
import { resolveBubbleSkin, legacyBubbleStaticUrl, type BubbleSkin } from '../src/account/bubble_skin';
import { normalizeMallItems } from '../src/account/web/dress_mall';
import type { AvatarCacheService } from '../src/bootstrap/avatar_cache';

/** 手工实测值(见 plan)。 */
const EXPECTED: Record<number, { slice: [number, number, number, number]; animated: boolean }> = {
  2078642: { slice: [64, 55, 62, 55], animated: true },
  2130704: { slice: [67, 66, 59, 44], animated: false },
  2141396: { slice: [53, 68, 73, 42], animated: true },
  2072805: { slice: [59, 69, 67, 41], animated: false },
};

/**
 * 直连 CDN 的假缓存 —— 这个脚本不该碰真的头像缓存目录(那是账号态的),也不需要落盘。
 * 只实现 resolveBubbleSkin 用到的 `get`。
 */
const directCache = {
  async get(url: string) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return {
      data: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get('content-type') ?? 'image/png',
      fromCache: false,
    };
  },
} as unknown as AvatarCacheService;

function fmt(s: BubbleSkin['slice']): string {
  return `L${s.left} T${s.top} R${s.right} B${s.bottom}`;
}

async function main(): Promise<void> {
  let failed = 0;

  console.log('── 老式路径(目录段 = itemId,自己探拉伸点/动效/文字色)──');
  for (const [id, want] of Object.entries(EXPECTED)) {
    const itemId = Number(id);
    const skin = await resolveBubbleSkin(directCache, itemId, {
      staticUrl: legacyBubbleStaticUrl(itemId),
    });

    if (!skin) {
      console.log(`❌ ${itemId}: 解析返回 null`);
      failed++;
      continue;
    }

    const got: [number, number, number, number] = [
      skin.slice.left,
      skin.slice.top,
      skin.slice.right,
      skin.slice.bottom,
    ];
    const sliceOk = got.every((v, i) => v === want.slice[i]);
    const animOk = skin.animated === want.animated;

    console.log(
      `${sliceOk && animOk ? '✅' : '❌'} ${itemId}: ${fmt(skin.slice)} ` +
        `${skin.imageSize.w}×${skin.imageSize.h} animated=${skin.animated} color=${skin.textColor}`,
    );
    if (!sliceOk) {
      console.log(`     期望 slice L${want.slice[0]} T${want.slice[1]} R${want.slice[2]} B${want.slice[3]}`);
      failed++;
    }
    if (!animOk) {
      console.log(`     期望 animated=${want.animated}`);
      failed++;
    }
  }

  // 不存在的 itemId 必须干净地回 null,而不是抛错或吐出一个瞎猜的 skin。
  const bogus = await resolveBubbleSkin(directCache, 1, { staticUrl: legacyBubbleStaticUrl(1) });
  console.log(`${bogus === null ? '✅' : '❌'} 不存在的 itemId=1 → ${bogus === null ? 'null' : '意外拿到 skin'}`);
  if (bogus !== null) failed++;

  // ── material 路径:新款 hash 目录。这是回归用例 ──
  //
  // 这些款按 itemId 拼 url 一律 404(目录段是服务端 nonce),曾经整批解析失败。现在改成
  // 由商城 material 提供权威外链 + zoomPoint,应当全部成功且**零额外探测请求**。
  console.log('\n── material 路径(新款 hash 目录,零探测)──');
  const items = normalizeMallItems(
    JSON.parse(readFileSync('resources/dress/ranking-bubble.json', 'utf-8')),
  );
  const hashed = items.filter((i) => i.material && !i.material.staticAll.includes(`/${i.itemId}/`));
  console.log(`   静态排行 ${items.length} 款,其中 ${hashed.length} 款是 hash 目录`);

  let matOk = 0;
  for (const item of hashed) {
    const m = item.material!;
    const skin = await resolveBubbleSkin(directCache, item.itemId, {
      staticUrl: m.staticAll,
      animationUrl: m.animationAll,
      zoomPoint: { x: m.zoomPointX, y: m.zoomPointY },
      color: m.color,
    });
    if (!skin) {
      console.log(`❌ ${item.itemId} 「${item.name}」解析失败`);
      failed++;
      continue;
    }
    matOk++;
    console.log(
      `✅ ${item.itemId} ${fmt(skin.slice)} ${skin.imageSize.w}×${skin.imageSize.h}` +
        ` animated=${skin.animated} color=${skin.textColor}  「${item.name}」`,
    );
  }
  console.log(`   hash 目录款成功 ${matOk}/${hashed.length}`);

  // 老式款走 material 也该一致 —— 两条路径对同一款必须给出同样的 slice。
  const legacyItem = items.find((i) => i.material?.staticAll.includes(`/${i.itemId}/`));
  if (legacyItem?.material) {
    const m = legacyItem.material;
    const viaMaterial = await resolveBubbleSkin(directCache, legacyItem.itemId, {
      staticUrl: m.staticAll,
      animationUrl: m.animationAll,
      zoomPoint: { x: m.zoomPointX, y: m.zoomPointY },
      color: m.color,
    });
    const viaProbe = await resolveBubbleSkin(directCache, legacyItem.itemId, {
      staticUrl: legacyBubbleStaticUrl(legacyItem.itemId),
    });
    const same =
      viaMaterial && viaProbe && JSON.stringify(viaMaterial.slice) === JSON.stringify(viaProbe.slice);
    console.log(
      `${same ? '✅' : '❌'} ${legacyItem.itemId} 两条路径 slice 一致` +
        ` (material=${viaMaterial ? fmt(viaMaterial.slice) : 'null'}` +
        ` probe=${viaProbe ? fmt(viaProbe.slice) : 'null'})`,
    );
    if (!same) failed++;
  }

  console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项不符`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('[bubble-skin] 失败:', e);
  process.exit(1);
});
