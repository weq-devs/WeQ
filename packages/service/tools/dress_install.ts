/**
 * 装扮安装(清单读写 + 气泡安装 + zip 解包)的离线校验。
 *
 * 气泡有两条路径:自带 material 的(商城来的,零探测)和只有 itemId 的(老式外链能中就
 * 中,否则要走 protocol 换取)。这里覆盖前者与老式那条 —— protocol 兜底需要注入好的在线
 * QQ,属于手工验证;字体同理,这里只验「没有在线实例时明确报错」。
 *
 * 手写的 zip 解包必须验:两种压缩方式(stored/deflate)、ttf 不在包首位、包里没有 ttf、
 * 以及垃圾输入不抛。zip 样本可用以下片段生成(可选,缺了会跳过对应用例):
 *
 *   python -c "
 *   import zipfile
 *   d=bytes(range(256))*40
 *   for n,c in [('deflate.zip',zipfile.ZIP_DEFLATED),('stored.zip',zipfile.ZIP_STORED)]:
 *       z=zipfile.ZipFile('tmp/ziptest/'+n,'w',c); z.writestr('readme.txt','hello'); z.writestr('59500.ttf',d); z.close()
 *   z=zipfile.ZipFile('tmp/ziptest/nottf.zip','w',zipfile.ZIP_DEFLATED); z.writestr('config.json','{}'); z.close()
 *   open('tmp/ziptest/expect.bin','wb').write(d)"
 *
 * 用法: pnpm tsx ./packages/service/tools/dress_install.ts
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DressInstallService, extractFirstTtf, fontFamilyFor } from '../src/account/dress_install';
import type { AvatarCacheService } from '../src/bootstrap/avatar_cache';
import type { TrpcNative } from '@weq/protocol';
import type { NtHelperBinding } from '@weq/native';

/** 直连 CDN 的假缓存 —— 与 bubble_skin 那个测试同一套,不碰真缓存目录。 */
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

/** 永远打不通的 native —— 字体路径这里只测「没有 pid 时报错」。 */
const noNative = {
  sendPacket: async () => {
    throw new Error('should not be called');
  },
} as unknown as TrpcNative;

/** Mock ntHelper with convertFont stub */
const mockNtHelper = {
  convertFont: () => {
    throw new Error('convertFont should not be called in test (no online instance)');
  },
} as unknown as NtHelperBinding;

async function main(): Promise<void> {
  let failed = 0;
  const check = (ok: boolean, label: string, extra = ''): void => {
    console.log(`${ok ? '✅' : '❌'} ${label}${extra ? ` ${extra}` : ''}`);
    if (!ok) failed++;
  };

  const root = mkdtempSync(join(tmpdir(), 'weq-dress-'));
  try {
    const svc = new DressInstallService(noNative, mockNtHelper, directCache, root, () => 0);

    // ---- 清单:空目录要给空清单,不能抛 ----
    const empty = svc.read();
    check(
      empty.bubbles.length === 0 && empty.fonts.length === 0 && empty.activeBubble === 0,
      '空目录 → 空清单',
    );

    // ---- 气泡:老式路径(目录段就是 itemId,无需凭证/在线实例)----
    const skin = await svc.installBubble(2078642);
    check(
      skin !== null && skin.slice.left === 64 && skin.slice.top === 55 && skin.animated,
      '装气泡 2078642',
      skin ? `slice L${skin.slice.left} T${skin.slice.top} animated=${skin.animated}` : '(null)',
    );
    check(existsSync(join(root, 'manifest.json')), '清单已落盘');
    check(svc.read().bubbles.length === 1, '清单里有 1 款气泡');

    // 重复装应当复用记录而不是再探一次
    const again = await svc.installBubble(2078642);
    check(again?.itemId === 2078642 && svc.read().bubbles.length === 1, '重复装气泡不重复记录');

    // ---- material 路径:外链/拉伸点/文字色全由商城给,零探测 ----
    const base = 'https://tianquan.gtimg.cn/immersive/bubble/2141396';
    const colored = await svc.installBubble(2141396, {
      staticAll: `${base}/static-all.png`,
      animationAll: `${base}/animation-all.png`,
      zoomPointX: 54,
      zoomPointY: 69,
      color: '0xFF11053b',
    });
    check(colored?.textColor === 'rgb(17 5 59)', '权威 color 生效', colored?.textColor ?? '');
    check(colored?.slice.left === 53 && colored?.animated === true, 'material 的 zoomPoint/动效生效');

    // 不存在的气泡要干净失败(没有 material、老式外链也 404、又没有在线实例)
    check((await svc.installBubble(1)) === null, '不存在的气泡 → null');

    // ---- 切换生效项 ----
    svc.setActive('bubble', 2078642);
    svc.setActive('font', 59500);
    const active = svc.read();
    check(active.activeBubble === 2078642 && active.activeFont === 59500, 'setActive 持久化');

    // ---- 作用范围:默认 mine,切换后持久化 ----
    check(active.scope === 'mine', '默认 scope=mine');
    svc.setScope('all');
    check(svc.read().scope === 'all', 'setScope 持久化');
    svc.setScope('mine');

    // ---- 聊天背景:三态 + 拷贝入库 ----
    check(active.background === 'none', '默认 background=none');
    check(svc.backgroundFile() === null, '未选图 → backgroundFile null');

    // 没选过图就切自定义 = 死状态(界面说有背景却画不出来),必须报错而不是默默接受。
    let bgErr = '';
    try {
      svc.setBackground('custom');
    } catch (e) {
      bgErr = e instanceof Error ? e.message : String(e);
    }
    check(bgErr.includes('还没有选择'), '未选图时切 custom 报错', bgErr);

    // 选图要**拷贝**进装扮目录 —— 记路径的话原图一挪就没了。
    const { writeFileSync: writeSync } = await import('node:fs');
    const srcPng = join(root, 'source.png');
    writeSync(srcPng, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const afterPick = svc.setCustomBackground(srcPng);
    check(afterPick.background === 'custom', '选图后自动切到 custom');
    check(
      afterPick.backgroundFile.startsWith(join(root, 'background')) &&
        existsSync(afterPick.backgroundFile),
      '自定义背景已拷进装扮目录',
      afterPick.backgroundFile,
    );
    // 原图删掉也不该影响 —— 这正是拷贝而非记路径的意义。
    rmSync(srcPng, { force: true });
    check(svc.backgroundFile() !== null, '原图删除后仍可用(已拷贝)');

    // 换扩展名时旧文件要清掉,否则 background/ 下会同时躺着 custom.png 和 custom.jpg。
    const oldFile = afterPick.backgroundFile;
    const srcJpg = join(root, 'source.jpg');
    writeSync(srcJpg, Buffer.from([0xff, 0xd8, 0xff]));
    svc.setCustomBackground(srcJpg);
    check(!existsSync(oldFile), '换扩展名后清掉旧图');

    let extErr = '';
    try {
      svc.setCustomBackground(join(root, 'source.txt'));
    } catch (e) {
      extErr = e instanceof Error ? e.message : String(e);
    }
    check(extErr.includes('不支持'), '非图片扩展名被拒', extErr);

    check(svc.setBackground('none').background === 'none', '可以切回不使用');

    // ---- 浮屏挂件 ----
    check(svc.setWidget('3').widgetId === '3', 'setWidget 持久化');
    check(svc.setWidget('').widgetId === '', '空串 = 不叠挂件');

    // ---- 不透明度收进 [0.05, 1] ----
    check(svc.setBackgroundOpacity(2).backgroundOpacity === 1, '不透明度上限 1');
    check(svc.setBackgroundOpacity(0).backgroundOpacity === 0.05, '不透明度下限 0.05');
    check(svc.setBackgroundOpacity(0.6).backgroundOpacity === 0.6, '正常值原样保留');
    check(
      svc.setBackgroundOpacity(Number.NaN).backgroundOpacity === 1,
      'NaN → 1(而不是写进一个不可读的清单)',
    );

    // ---- 字体:没有在线实例必须明确报错,而不是静默失败 ----
    let msg = '';
    try {
      await svc.installFont(59500, '测试字体');
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    check(msg.includes('QQ 客户端'), '无在线实例时装字体报错', msg);
    check(svc.fontFile(59500) === null, '未装字体 → fontFile null');

    // ---- family 名与渲染侧约定一致 ----
    check(fontFamilyFor(59500) === 'weq-dress-59500', 'family 名约定');

    // ---- 损坏的清单要降级成空清单 ----
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(root, 'manifest.json'), '{ this is not json');
    check(svc.read().bubbles.length === 0, '损坏清单 → 空清单(不抛)');

    // ---- 老清单(背景/挂件字段还不存在时写的)要补齐,不能漏 undefined 给渲染侧 ----
    writeFileSync(
      join(root, 'manifest.json'),
      JSON.stringify({ bubbles: [], fonts: [], activeBubble: 0, activeFont: 0, scope: 'mine' }),
    );
    const legacy = svc.read();
    check(legacy.background === 'none', '老清单补 background=none');
    check(legacy.backgroundFile === '', '老清单补 backgroundFile=""');
    check(legacy.widgetId === '', '老清单补 widgetId=""');
    check(legacy.backgroundOpacity === 1, '老清单补 backgroundOpacity=1');

    // 清单被人手改坏了个别字段也不该漏出去。
    writeFileSync(
      join(root, 'manifest.json'),
      JSON.stringify({ bubbles: [], fonts: [], background: 'bogus', backgroundOpacity: 'x' }),
    );
    const bogus = svc.read();
    check(bogus.background === 'none', '未知 background 值 → none');
    check(bogus.backgroundOpacity === 1, '非法不透明度 → 1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // ---- zip 解包:用 tmp/ziptest 下的样本(若已生成)----
  const zipDir = 'tmp/ziptest';
  if (existsSync(join(zipDir, 'deflate.zip'))) {
    const want = readFileSync(join(zipDir, 'expect.bin'));
    for (const f of ['deflate.zip', 'stored.zip']) {
      const got = extractFirstTtf(readFileSync(join(zipDir, f)));
      check(got?.equals(want) === true, `解包 ${f}`, got ? `${got.length}B` : '(null)');
    }
    check(extractFirstTtf(readFileSync(join(zipDir, 'nottf.zip'))) === null, '包里没有 ttf → null');
  } else {
    console.log(`⏭  ${zipDir} 不存在,跳过 zip 用例`);
  }

  // 真实的气泡包也是 zip(stored + deflate 混合),拿它验「没有 ttf 时干净返回 null」。
  const realZip = 'tmp/bubble/other.zip';
  if (existsSync(realZip)) {
    check(extractFirstTtf(readFileSync(realZip)) === null, '真实气泡包(无 ttf)→ null');
  }

  // 垃圾输入不能抛。
  check(extractFirstTtf(Buffer.from('not a zip at all')) === null, '非 zip 输入 → null');
  check(extractFirstTtf(Buffer.alloc(0)) === null, '空 buffer → null');

  console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项不符`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('[dress-install] 失败:', e);
  process.exit(1);
});
