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
 *     换下载链，两者都不需要在这里落 url。
 *   - 界面字体(305) 混在 apps["5"] 桶里返回，这里只要聊天字体(5)，故按项内 appId 取。
 *
 * 关于 chatBgUrl（聊天背景，appId 8）：
 *   - 与 screenUrl（浮屏，appId 22）是两回事，别混：那个是飘在界面上的动画。
 *   - 存 url 而不是 itemId —— 与气泡相反，背景的目录段是服务端 nonce，推不出来。
 *   - 用 hdUrl（aioImage，720×1280）而不是 previewUrl（320×568 缩略图）。
 *     两者的换算在 self_dress 的 chatBgHdUrl 里，这里只取结果。
 */

import type { AccountSession } from '@weq/account';
import { WebCredentialProvider } from './web/credential';
import type { WebNative } from './web/credential';
import type { FriendDress } from './web/friend_dress';
import { getSelfDress } from './web/self_dress';
import { getLogger, logErrorContext } from '../common/logger';

const BUBBLE = 2;
const WIDGET = 4;
const CHAT_FONT = 5;
const CHAT_BG = 8;
const CARD = 15;
/** 来电（通话背景 + 铃声）。appId 17 的条目同时带静态图和动态视频。 */
const CALL_BG = 17;
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
  /** 正在用的头像挂件 itemId（appId 4）。 */
  widgetId?: number;
  /** 挂件款名。 */
  widgetName?: string;
  /** 挂件预览图直链（newPreview2，已 upgradePreview）。 */
  widgetPreviewUrl?: string;
  /**
   * 正在用的通话背景（appId 17）。
   *
   * 通话窗口拿它当底图。`callBgVideoUrl` 有值时优先播视频 —— 这类装扮本来
   * 就是动态的，静帧只是它的首帧。两个都空表示用户没设通话背景。
   *
   * 注意：这一项**不需要联网刷新**（URL 是不带签名的静态 CDN 地址），所以
   * 发起通话时直接读快照即可，只有快照里完全没有这个字段时才需要去查一次。
   */
  callBgUrl?: string;
  /** 通话背景的动态版（`funCall/item/<id>/media.mp4`）。 */
  callBgVideoUrl?: string;
  /** 通话背景装扮的 itemId（界面显示名字 / 去装扮页定位用）。 */
  callBgId?: number;
  /** 通话背景装扮的款名。 */
  callBgName?: string;
  /**
   * 这次抓取是否覆盖了通话背景（写入时刻，毫秒）。
   *
   * 用来区分「用户没设背景」与「老快照压根没查过这一项」——光看 `callBgUrl` 为不
   * 为空分不清这两种，通话时就会每次都白查一遍。见 `call_background.ts`。
   */
  callBgCheckedAt?: number;
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
 * @param seedPskey 登录时收下的 p_skey（域 → p_skey），用来省掉一次 hook 往返
 * @param onSeedInvalidated 上面那份票据被判失效时调用（让落盘那份也删掉）
 */
export async function fetchHomeDress(
  nt: WebNative,
  session: AccountSession,
  pid: number,
  seedPskey?: Record<string, string>,
  onSeedInvalidated?: (domain: string) => void,
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
    self = await getSelfDress(await resolveCred(nt, uin, pid, seedPskey, onSeedInvalidated));
  } catch (e) {
    if (!seedPskey) throw e;
    logger.warn('self dress failed with seeded pskey; retrying via live hook', {
      event: 'home-dress-seed-retry',
      pid,
      ...logErrorContext(e),
    });
    // 既然这份 seed 用不了就把落盘那份也删掉（见 `clearLoginPskey`）—— 这里的 cgi 不
    // 会报 `WebAuthError`，所以 provider 的失效回调不会触发，得自己删。留着只会让下次
    // 开账号又先白失败一轮；代价是以后多打一次 hook 而已。
    if (seedPskey[VIP_DOMAIN]) dropSeededDomain(onSeedInvalidated, VIP_DOMAIN);
    self = await getSelfDress(await resolveCred(nt, uin, pid, undefined, onSeedInvalidated));
  }

  const pick = (appId: number) => self.items.find((i) => i.appId === appId);

  const widgetItem = pick(WIDGET);
  const cardItem = pick(CARD);
  const screenItem = pick(SCREEN);
  const bubbleItem = pick(BUBBLE);
  const fontItem = pick(CHAT_FONT);
  const chatBgItem = pick(CHAT_BG);
  const callBgItem = pick(CALL_BG);

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
  // 挂件：名字/预览图/动画帧要按 itemId 去换，快照里必须存 id（widgetUrl 只是
  // 预览图，装上之后渲染走帧动画，不再用它）。
  if (widgetItem?.itemId) {
    snapshot.widgetId = widgetItem.itemId;
    if (widgetItem.name) snapshot.widgetName = widgetItem.name;
    if (widgetUrl) snapshot.widgetPreviewUrl = widgetUrl;
  }

  // 聊天背景**不走 upgradePreview** —— 那套是 newPreview1→2 的换名，与背景无关。
  // 背景的高清图是同目录的 aioImage（720×1280），getSelfDress 已经算好放在 hdUrl 里
  // （目录段是服务端 nonce，推不出来，见 self_dress 的 chatBgHdUrl）。没有 hdUrl 时
  // 退回 previewUrl —— 那是 320×568 的缩略图，糊，但比没有强。
  const chatBgUrl = chatBgItem?.hdUrl || chatBgItem?.previewUrl || '';
  if (chatBgUrl) snapshot.chatBgUrl = chatBgUrl;

  // 通话背景：静态图一列，动态视频在 extraimage.images 里（以 .mp4 结尾）。
  // 与聊天背景同理，目录段不一定是 itemId，所以只认接口给的完整 URL。
  // 无论有没有设，都记下「这一项查过了」——通话时据此决定要不要再联网。
  snapshot.callBgCheckedAt = Date.now();
  if (callBgItem?.itemId) {
    snapshot.callBgId = callBgItem.itemId;
    if (callBgItem.name) snapshot.callBgName = callBgItem.name;
    const still = callBgItem.previewUrl || '';
    const video = callBgItem.hdUrl && /\.mp4(\?|$)/i.test(callBgItem.hdUrl) ? callBgItem.hdUrl : '';
    if (still) snapshot.callBgUrl = still;
    if (video) snapshot.callBgVideoUrl = video;
  }

  logger.info('fetched home dress snapshot', {
    event: 'home-dress-fetched',
    hasWidget: Boolean(widgetUrl),
    hasCard: Boolean(cardUrl),
    hasCardVideo: Boolean(cardVideoUrl),
    hasScreen: Boolean(screenUrl),
    tagCount: tags.length,
    bubbleId: snapshot.bubbleId ?? 0,
    fontId: snapshot.fontId ?? 0,
    widgetId: snapshot.widgetId ?? 0,
    hasChatBg: Boolean(snapshot.chatBgUrl),
    callBgId: snapshot.callBgId ?? 0,
  });

  return snapshot;
}

/**
 * 调持有方的「把落盘 seed 删掉」钩子。删盘失败只记日志 —— 装扮抓取本身不该因此
 * 失败（与 `WebCredentialProvider.dropSeededPskey` 同一套容错）。
 */
function dropSeededDomain(
  onSeedInvalidated: ((domain: string) => void) | undefined,
  domain: string,
): void {
  try {
    onSeedInvalidated?.(domain);
  } catch (error) {
    getLogger()
      .child({ scope: 'home-dress' })
      .warn('failed to drop invalid login pskey', {
        event: 'drop-seeded-pskey-failed',
        domain,
        ...logErrorContext(error),
      });
  }
}

/** vip.qq.com 的凭证。`seedPskey` 为空时强制走活 hook。 */
async function resolveCred(
  nt: WebNative,
  uin: string,
  pid: number,
  seedPskey: Record<string, string> | undefined,
  onSeedInvalidated?: (domain: string) => void,
) {
  const creds = new WebCredentialProvider(nt, uin, () => pid, onSeedInvalidated);
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
  const pick = (appId: number) => dress.items.find((i) => i.appId === appId && i.itemId !== 0);
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
