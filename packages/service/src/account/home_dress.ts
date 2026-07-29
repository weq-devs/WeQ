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
 */

import type { AccountSession } from '@weq/account';
import type { NtHelperBinding } from '@weq/native';
import { WebCredentialProvider } from './web/credential';
import { getSelfDress } from './web/self_dress';
import { getLogger, logErrorContext } from '../common/logger';

const BUBBLE = 2;
const WIDGET = 4;
const CHAT_FONT = 5;
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
  /** 正在用的聊天字体 itemId（不含界面字体 305）。 */
  fontId?: number;
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
    logger.warn('failed to read profile interests', { event: 'home-dress-tags-failed', ...logErrorContext(e) });
  }

  const snapshot: HomeDressSnapshot = { widgetUrl, cardUrl, cardVideoUrl, screenUrl, tags };
  if (bubbleItem?.itemId) snapshot.bubbleId = bubbleItem.itemId;
  if (fontItem?.itemId) snapshot.fontId = fontItem.itemId;

  logger.info('fetched home dress snapshot', {
    event: 'home-dress-fetched',
    hasWidget: Boolean(widgetUrl),
    hasCard: Boolean(cardUrl),
    hasCardVideo: Boolean(cardVideoUrl),
    hasScreen: Boolean(screenUrl),
    tagCount: tags.length,
    bubbleId: snapshot.bubbleId ?? 0,
    fontId: snapshot.fontId ?? 0,
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
