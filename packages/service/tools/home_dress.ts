/**
 * 一把梭:取齐首页(ChatHome)所需的 5 个 `settings.homeDress` 值并打印成可直接粘贴的 JSON。
 *
 *   widgetUrl     挂件(appId 4)   ← getSelfDress
 *   cardUrl       名片静图(15)     ← getSelfDress
 *   cardVideoUrl  名片视频         ← getFriendDress(自己uin) 的权威 immersiveMaterial.videoUrl
 *   screenUrl     浮屏(22)         ← getSelfDress
 *   tags          个性标签         ← profile_info.db 的 profile_info_v6#21000
 *
 * 为什么要两个装扮端点:
 *  - getSelfDress(JSON, 按 cookie 认人)每项只有 appId/itemId/img/name 四个字段,**没有**
 *    任何视频字段(已 dump 原始响应确认)。
 *  - 名片视频的权威值只在 getFriendDress(SSR 页面)的 `extraInfo.immersiveMaterial.videoUrl`。
 *    名片不在 friend_dress 的剔除名单里(那只剔气泡2/字体5/头像23),所以拿自己的 uin 去查
 *    就能拿到真值。
 *    别按预览图路径去推:实测 `card/item/<id>/newPreview2.mp4` 也回 200,但只有 477×848,
 *    而权威的 `immersive/card/<id>/newPreview_<id>.mp4` 是 720×1280 —— 不同目录的不同文件,
 *    光看 HTTP 200 会拿到低清版还以为自己对了。
 *
 * 装扮走 cookie 认人 ⇒ 只能取**当前登录**那个号的。所以脚本要求 QQ 登录的 uin 必须与
 * `.env` 的 WEQ_TEST_UIN 一致,不一致直接报错,免得把 A 号的装扮写进 B 号的配置。
 * 个性标签则纯读本地 db,与登录态无关。
 *
 * 用法: pnpm tsx ./packages/service/tools/home_dress.ts
 *   linux 需 root(ptrace 注入): sudo -E node --import tsx packages/service/tools/home_dress.ts
 */

import { loadNative } from '@weq/native';
import { ProfileInfoDb } from '@weq/db';
import { ensureSendable, testEnv } from '@weq/testkit';
import { WebCredentialProvider } from '../src/account/web/credential';
import { getFriendDress } from '../src/account/web/friend_dress';
import { getSelfDress } from '../src/account/web/self_dress';

/** 首页要的那 5 个值 —— 与 service/src/bootstrap/user_config.ts 的 HomeDressConfig 同构。 */
interface HomeDress {
  widgetUrl: string;
  cardUrl: string;
  cardVideoUrl: string;
  screenUrl: string;
  tags: string[];
}

const WIDGET = 4;
const CARD = 15;
const SCREEN = 22;

async function main(): Promise<void> {
  const want = testEnv.uin;
  const nt = loadNative().ntHelper;

  // ---- 1. 找到登录着 want 这个号的 QQ 进程 ----
  const pids = nt.getQqProcesses();
  if (pids.length === 0) throw new Error('没有运行中的 QQ.exe,请先打开并登录');

  let pid = 0;
  let probed_uin : string | undefined;
  const seen: string[] = [];
  for (const p of pids) {
    const probed = nt.probeQqLoginInfo(p);
    seen.push(`pid=${p} uin=${probed?.uin || '(未登录)'}`);
    // if (probed?.uin === want) pid = p;
    probed_uin = probed?.uin
    pid = p;
  }
  console.log(`[home-dress] QQ 进程: ${seen.join(', ')}`);
  if (pid === 0 || !probed_uin) {
    throw new Error(
      `没有登录着 ${want} 的 QQ 进程。装扮按 cookie 认人,只能取当前登录号的 —— ` +
        `请用 ${want} 登录 QQ,或把 .env 的 WEQ_TEST_UIN 改成实际登录的号。`,
    );
  }
  console.log(`[home-dress] 使用 pid=${pid} uin=${probed_uin}\n`);

  await ensureSendable(nt, pid, { label: 'home-dress' });

  const cred = await new WebCredentialProvider(nt, probed_uin, () => pid).forDomain('vip.qq.com');

  // ---- 2. 自己的装扮:挂件 / 名片静图 / 浮屏 ----
  const self = await getSelfDress(cred);
  const pick = (appId: number): string =>
    self.items.find((i) => i.appId === appId)?.previewUrl ?? '';

  console.log(`[home-dress] getSelfDress 拿到 ${self.items.length} 项:`);
  for (const i of self.items) {
    console.log(`    appId=${String(i.appId).padStart(3)} ${i.kind}\t${i.name}`);
  }

  // ---- 3. 名片视频:走好友装扮页拿权威值 ----
  const friend = await getFriendDress(cred, want);
  const cardVideoUrl = friend?.items.find((i) => i.appId === CARD)?.videoUrl ?? '';
  if (!friend) {
    console.log('\n[home-dress] ⚠ getFriendDress 解析失败(风控/页面改版?),名片视频取不到');
  } else if (!cardVideoUrl) {
    console.log('\n[home-dress] 名片没有视频资源(静态名片),cardVideoUrl 留空');
  }

  // ---- 4. 个性标签:本地 profile_info.db 的 21000 列 ----
  const db = new ProfileInfoDb(nt, {
    dbPath: testEnv.profileDbPath,
    key: testEnv.key,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });
  let tags: string[] = [];
  try {
    const profile = await db.getProfileByUin(BigInt(want));
    tags = profile?.extInfo?.interests ?? [];
    if (!profile) {
      console.log(`\n[home-dress] ⚠ profile_info_v6 里没有 uin=${want} 的行`);
    } else if (tags.length === 0) {
      console.log(
        '\n[home-dress] 个性标签为空。21000 列要在 QQ 里打开过自己的资料卡才会回写;' +
          '若本来就没设标签,首页会自动降级成一言打字机。',
      );
    }
  } finally {
    db.close();
  }

  // ---- 5. 汇总 ----
  const dress: HomeDress = {
    widgetUrl: pick(WIDGET),
    cardUrl: pick(CARD),
    cardVideoUrl,
    screenUrl: pick(SCREEN),
    tags,
  };

  console.log('\n════════ settings.homeDress(粘进 %APPDATA%/weq/config.json 的 settings 里)════════');
  console.log(JSON.stringify({ homeDress: dress }, null, 2));

  const missing = (Object.keys(dress) as Array<keyof HomeDress>).filter((k) =>
    Array.isArray(dress[k]) ? (dress[k] as string[]).length === 0 : !dress[k],
  );
  console.log(
    missing.length === 0
      ? '\n[home-dress] ✅ 5 项齐全'
      : `\n[home-dress] 以下项为空(首页会各自降级): ${missing.join(', ')}`,
  );
}

main().catch((e) => {
  console.error('[home-dress] 失败:', e);
  process.exit(1);
});
