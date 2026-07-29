/**
 * 首页个性装扮快照抓取。
 *
 * 在线注入成功后作为并发任务调用，结果写入账号 config（不阻塞 key 获取主流程）。
 * 失败静默降级——首页各项有自己的降级方案。
 *
 * 关于 cardVideoUrl：
 *   - 先尝试权威路径 immersive/card/<id>/newPreview_<id>.mp4（720×1280）
 *   - 若 404 则留空（静态名片）
 *   - 不走 getFriendDress SSR 页面，避免额外网络往返；itemId 已在 getSelfDress 里拿到
 *
 * 关于 previewUrl：
 *   - getSelfDress 返回的是 newPreview1.xxx，尝试换成 newPreview2.xxx（更大更清晰）
 *   - 换后 HEAD 失败则回退原 url
 *
 * 关于 bubbleId / fontId：
 *   - 只存 itemId，不存 url。气泡的九宫格资源外链纯 itemId 可预测
 *     (immersive/bubble/<itemId>/static-*.png)，渲染侧自己拼；字体得走 protocol
 *     换下载链（见 dress_install），两者都不需要在这里落 url。
 *   - 界面字体(305) 混在 apps["5"] 桶里返回，这里只要聊天字体(5)，故按项内 appId 取。
 *
 * 关于 chatBgUrl（聊天背景，appId 8）：
 *   - 与 screenUrl（浮屏，appId 22）是两回事，别混：那个是飘在界面上的动画。
 *   - 存 url 而不是 itemId —— 与气泡相反，背景的目录段是服务端 nonce，推不出来。
 *   - 用 hdUrl（aioImage，720×1280）而不是 previewUrl（320×568 缩略图）。
 *     两者的换算在 self_dress 的 chatBgHdUrl 里，这里只取结果。
 */

import type { AccountSession } from '@weq/account';
import type { NtHelperBinding } from '@weq/native';
import { WebCredentialProvider } from './web/credential';
import type { FriendDress } from './web/friend_dress';
import { getSelfDress } from './web/self_dress';
import { getLogger, logErrorContext } from '../common/logger';

const BUBBLE = 2;
const WIDGET = 4;
const CHAT_FONT = 5;
const CHAT_BG = 8;
const CARD = 15;
const SCREEN = 22;

const VIP_DOMAIN = 'vip.qq.com';

export interface HomeDressSnapshot {
  widgetUrl: string;
  cardUrl: string;
  cardVideoUrl: string;
  screenUrl: string;
  tags: string[];
  /** 正在用的气泡 itemId（0/缺省表示没有）。渲染侧据此拼九宫格外链。 */
  bubbleId?: number;
  /** 气泡款名（如「简约鲸鱼」）。接口本来就回，不存下来装扮页就只能显示 id。 */
  bubbleName?: string;
  /**
   * 气泡预览图直链。
   *
   * **必须存 url 不能存 id** —— 目录段有时是服务端 nonce（本账号字体 59500 的预览就是
   * `font/item/bdcb3f9c3b3967be/`，按 itemId 拼一律 404）。气泡碰巧是 itemId 目录，
   * 但同一个字段两类都要装，一律照抄接口给的。
   */
  bubblePreviewUrl?: string;
  /** 正在用的聊天字体 itemId（不含界面字体 305）。 */
  fontId?: number;
  /** 字体款名。 */
  fontName?: string;
  /** 字体预览图直链。理由同 {@link bubblePreviewUrl}。 */
  fontPreviewUrl?: string;
  /**
   * 正在用的聊天背景图（720×1280 原图）。空串 = 没设背景。
   *
   * 与 screenUrl 不是一回事：那个是浮屏（appId 22，飘在界面上的动画），
   * 这个是贴在聊天窗后面的底图（appId 8）。
   */
  chatBgUrl?: string;
}

/** newPreview1.xxx → newPreview2.xxx（同扩展名）。 */
function tryPreview2(url: string): string {
  return url.replace(/(newPreview)1(\.[^./?]+)($|\?)/, '$12$2$3');
}

/** HEAD 检查 url 是否可访问（200–299）。失败返回 false。 */
async function headOk(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { method: 'HEAD' });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * 尝试把 previewUrl 升级到 newPreview2 版本。
 * 如果 url 里没有 newPreview1 或 HEAD 失败，返回原 url。
 */
async function upgradePreview(url: string): Promise<string> {
  if (!url) return url;
  const upgraded = tryPreview2(url);
  if (upgraded === url) return url;
  return (await headOk(upgraded)) ? upgraded : url;
}

/**
 * 从 itemId 推断名片视频 url（immersive 高清路径）。
 * 返回 null 表示没有视频（静态名片）。
 */
async function resolveCardVideoUrl(itemId: number): Promise<string> {
  if (!itemId) return '';
  const url = `https://tianquan.gtimg.cn/immersive/card/${itemId}/newPreview_${itemId}.mp4`;
  return (await headOk(url)) ? url : '';
}

/**
 * 抓取本账号的首页装扮快照。
 *
 * @param nt       native helper（用于获取 web 凭证）
 * @param session  当前账号 session（取 uin + profileInfo db）
 * @param pid      已注入的 QQ 进程 pid
 */
export async function fetchHomeDress(
  nt: Pick<NtHelperBinding, 'fetchSkey' | 'fetchPskey' | 'fetchClientKey'>,
  session: AccountSession,
  pid: number,
  seedPskey?: Record<string, string>,
): Promise<HomeDressSnapshot> {
  const logger = getLogger().child({ scope: 'home-dress', accountUin: session.context.uin });
  const uin = session.context.uin;

  // ---- 1. 自己的装扮 ----
  // seed 票据是登录时收下的，p_skey 服务端时效很短，落盘那份很可能已经过期。过期的 seed
  // 会短路掉 WebCredentialProvider 的 hook 查询（见 credential.ts 的 seedPskey），让本来
  // 能成功的在线实例也抓不到，且失败是静默的。所以 seed 失败后丢掉 seed 重试一次走活 hook。
  // 不按时间戳判过期 —— p_skey 的真实 TTL 没有可靠依据，宁可多一次往返也别硬编码猜测值。
  let self: Awaited<ReturnType<typeof getSelfDress>>;
  try {
    self = await getSelfDress(await resolveCred(nt, uin, pid, seedPskey));
  } catch (e) {
    if (!seedPskey) throw e;
    logger.warn('self dress failed with seeded pskey; retrying via live hook', {
      event: 'home-dress-seed-retry',
      pid,
      ...logErrorContext(e),
    });
    self = await getSelfDress(await resolveCred(nt, uin, pid, undefined));
  }

  const pick = (appId: number) => self.items.find((i) => i.appId === appId);

  const widgetItem = pick(WIDGET);
  const cardItem = pick(CARD);
  const screenItem = pick(SCREEN);
  const bubbleItem = pick(BUBBLE);
  const fontItem = pick(CHAT_FONT);
  const chatBgItem = pick(CHAT_BG);

  // ---- 2. 并发升级 preview url + 解析名片视频 ----
  const [widgetUrl, cardUrl, screenUrl, cardVideoUrl] = await Promise.all([
    upgradePreview(widgetItem?.previewUrl ?? ''),
    upgradePreview(cardItem?.previewUrl ?? ''),
    upgradePreview(screenItem?.previewUrl ?? ''),
    resolveCardVideoUrl(cardItem?.itemId ?? 0),
  ]);

  // ---- 3. 个性标签（本地 profile_info.db，无需网络）----
  let tags: string[] = [];
  try {
    const profile = await session.profileInfo.getProfileByUin(BigInt(uin));
    tags = profile?.extInfo?.interests ?? [];
  } catch (e) {
    logger.warn('failed to read profile interests', {
      event: 'home-dress-tags-failed',
      ...logErrorContext(e),
    });
  }

  const snapshot: HomeDressSnapshot = { widgetUrl, cardUrl, cardVideoUrl, screenUrl, tags };
  // 气泡/字体:名字和预览图接口本来就回(每项都有 name/img),之前只挑了 itemId,
  // 结果装扮页只能显示「QQ 正在用的气泡」+ 空白预览。这里一并存下来。
  if (bubbleItem?.itemId) {
    snapshot.bubbleId = bubbleItem.itemId;
    if (bubbleItem.name) snapshot.bubbleName = bubbleItem.name;
    if (bubbleItem.previewUrl) snapshot.bubblePreviewUrl = bubbleItem.previewUrl;
  }
  if (fontItem?.itemId) {
    snapshot.fontId = fontItem.itemId;
    if (fontItem.name) snapshot.fontName = fontItem.name;
    if (fontItem.previewUrl) snapshot.fontPreviewUrl = fontItem.previewUrl;
  }
  // 聊天背景**不走 upgradePreview** —— 那套是 newPreview1→2 的换名，与背景无关。
  // 背景的高清图是同目录的 aioImage（720×1280），getSelfDress 已经算好放在 hdUrl 里
  // （目录段是服务端 nonce，推不出来，见 self_dress 的 chatBgHdUrl）。没有 hdUrl 时
  // 退回 previewUrl —— 那是 320×568 的缩略图，糊，但比没有强。
  const chatBgUrl = chatBgItem?.hdUrl || chatBgItem?.previewUrl || '';
  if (chatBgUrl) snapshot.chatBgUrl = chatBgUrl;

  logger.info('fetched home dress snapshot', {
    event: 'home-dress-fetched',
    hasWidget: Boolean(widgetUrl),
    hasCard: Boolean(cardUrl),
    hasCardVideo: Boolean(cardVideoUrl),
    hasScreen: Boolean(screenUrl),
    tagCount: tags.length,
    bubbleId: snapshot.bubbleId ?? 0,
    fontId: snapshot.fontId ?? 0,
    hasChatBg: Boolean(snapshot.chatBgUrl),
  });

  return snapshot;
}

/** vip.qq.com 的凭证。`seedPskey` 为空时强制走活 hook。 */
async function resolveCred(
  nt: Pick<NtHelperBinding, 'fetchSkey' | 'fetchPskey' | 'fetchClientKey'>,
  uin: string,
  pid: number,
  seedPskey: Record<string, string> | undefined,
) {
  const creds = new WebCredentialProvider(nt, uin, () => pid);
  if (seedPskey) creds.seedPskey(seedPskey);
  return creds.forDomain(VIP_DOMAIN);
}

/**
 * 他人的个性主页素材（挂件 / 名片 / 浮屏），由 {@link ./web/friend_dress} 的 SSR
 * 结果翻成与 {@link HomeDressSnapshot} 同构的形状，供渲染侧与自己的首页共用一套组件。
 *
 * 与自己的快照有两点不同：
 *  - 没有 tags/气泡/字体/聊天背景 —— 个性标签走 profile_info_v6（调用方自己有），
 *    另外三类 SSR 页面对他人只回默认款（见 friend_dress 的 UNRESOLVABLE_APPS）。
 *  - 名片视频**优先用 SSR 给的权威 videoUrl**（immersiveMaterial 里那条 720×1280），
 *    只有它缺失时才回退到按 itemId 拼 immersive 路径的猜测值。
 */
export interface PeerDressSnapshot {
  widgetUrl: string;
  cardUrl: string;
  cardVideoUrl: string;
  screenUrl: string;
  /** 装扮页附带的对方头像（与本地缓存的头像可能不同尺寸，作为兜底）。 */
  avatarUrl: string;
  isSvip: boolean;
}

export async function toPeerDress(dress: FriendDress): Promise<PeerDressSnapshot> {
  /**
   * 没设该类装扮时接口回的是「默认款」（`itemId: 0`），素材是 QQ 自己的推广图
   * （如 `card/item/0/new1.png`）—— 那是广告不是这个人的装扮，一律当没有。
   */
  const pick = (appId: number) =>
    dress.items.find((i) => i.appId === appId && i.itemId !== 0);
  const widgetItem = pick(WIDGET);
  const cardItem = pick(CARD);
  const screenItem = pick(SCREEN);

  const [widgetUrl, cardUrl, screenUrl, guessedVideo] = await Promise.all([
    upgradePreview(widgetItem?.previewUrl ?? ''),
    upgradePreview(cardItem?.previewUrl ?? ''),
    upgradePreview(screenItem?.previewUrl ?? ''),
    cardItem?.videoUrl ? Promise.resolve('') : resolveCardVideoUrl(cardItem?.itemId ?? 0),
  ]);

  return {
    widgetUrl,
    cardUrl,
    cardVideoUrl: cardItem?.videoUrl || guessedVideo,
    screenUrl,
    avatarUrl: dress.avatarUrl,
    isSvip: dress.isSvip,
  };
}
