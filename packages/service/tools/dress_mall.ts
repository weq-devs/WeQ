/**
 * 商城响应归一化的离线校验。
 *
 * 不需要 QQ 在线 —— 直接喂仓库里已有的原始响应:静态排行榜资源
 * (`resources/dress/ranking-bubble.json`)+ tmp 下四份 HAR(气泡/字体 × 排行/搜索)。
 *
 * 重点是确认 {@link normalizeMallItems} 对**两种形状通吃**:排行榜包了一层
 * `items[].item`,搜索是直接的 `results[]`。以及字体那边 immersiveMaterial 常常是空串
 * (engine=2 的老字体)时不炸。
 *
 * 用法: pnpm tsx ./packages/service/tools/dress_mall.ts
 */

import { existsSync, readFileSync } from 'node:fs';
import { normalizeMallItems } from '../src/account/web/dress_mall';

/** 取 HAR 里第一条响应的 JSON body。 */
function harBody(path: string): unknown {
  const har = JSON.parse(readFileSync(path, 'utf8')) as {
    log: { entries: Array<{ response: { content: { text: string } } }> };
  };
  return JSON.parse(har.log.entries[0]!.response.content.text);
}

const SAMPLES: Array<{ label: string; path: string; kind: 'json' | 'har'; minItems: number }> = [
  { label: '静态排行(气泡)', path: 'resources/dress/ranking-bubble.json', kind: 'json', minItems: 20 },
  { label: '排行 HAR(气泡)', path: 'tmp/bubble.har', kind: 'har', minItems: 20 },
  { label: '搜索 HAR(气泡)', path: 'tmp/bubble_search.har', kind: 'har', minItems: 40 },
  { label: '排行 HAR(字体)', path: 'tmp/font.har', kind: 'har', minItems: 20 },
  { label: '搜索 HAR(字体)', path: 'tmp/font_search.har', kind: 'har', minItems: 40 },
];

function main(): void {
  let failed = 0;

  for (const s of SAMPLES) {
    if (!existsSync(s.path)) {
      console.log(`⏭  ${s.label}: ${s.path} 不存在,跳过`);
      continue;
    }
    const payload = s.kind === 'har' ? harBody(s.path) : JSON.parse(readFileSync(s.path, 'utf8'));
    const items = normalizeMallItems(payload);

    const bad = items.filter((i) => !i.itemId || !i.appId || !i.name || !i.previewUrl);
    const ok = items.length >= s.minItems && bad.length === 0;
    if (!ok) failed++;

    console.log(
      `${ok ? '✅' : '❌'} ${s.label}: ${items.length} 条(≥${s.minItems})` +
        ` 动效 ${items.filter((i) => i.animated).length}` +
        ` 有color ${items.filter((i) => i.color).length}` +
        ` 字段不全 ${bad.length}`,
    );
    const f = items[0];
    if (f) {
      console.log(
        `      #1 id=${f.itemId} appId=${f.appId} "${f.name}" ${f.price}Q` +
          ` [${f.labels.join('/')}] anim=${f.animated} color=${f.color || '(none)'}`,
      );
    }
    for (const b of bad.slice(0, 3)) {
      console.log(`      ⚠ 字段不全: ${JSON.stringify(b)}`);
    }
  }

  // 垃圾输入必须回空数组而不是抛错 —— 静态资源缺失/损坏时装扮页要能降级。
  for (const junk of [{}, { response: {} }, { response: { items: [] } }, null, 'nope']) {
    const got = normalizeMallItems(junk);
    if (!Array.isArray(got) || got.length !== 0) {
      console.log(`❌ 垃圾输入 ${JSON.stringify(junk)} → 期望空数组,实际 ${JSON.stringify(got)}`);
      failed++;
    }
  }
  console.log('✅ 垃圾输入一律回空数组');

  console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项不符`);
  if (failed > 0) process.exit(1);
}

main();
