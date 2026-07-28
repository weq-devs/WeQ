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
 */

import type { AccountSession } from '@weq/account';
import type { NtHelperBinding } from '@weq/native';
import { WebCredentialProvider } from './web/credential';
import { getSelfDress } from './web/self_dress';
import { getLogger, logErrorContext } from '../common/logger';

const WIDGET = 4;
const CARD = 15;
const SCREEN = 22;

const VIP_DOMAIN = 'vip.qq.com';

export interface HomeDressSnapshot {
  widgetUrl: string;
  cardUrl: string;
  cardVideoUrl: string;
  screenUrl: string;
  tags: string[];
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

  const creds = new WebCredentialProvider(nt, uin, () => pid);
  if (seedPskey) creds.seedPskey(seedPskey);
  const cred = await creds.forDomain(VIP_DOMAIN);

  // ---- 1. 自己的装扮（挂件/名片静图/浮屏）----
  const self = await getSelfDress(cred);
  const pick = (appId: number) => self.items.find((i) => i.appId === appId);

  const widgetItem = pick(WIDGET);
  const cardItem = pick(CARD);
  const screenItem = pick(SCREEN);

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

  logger.info('fetched home dress snapshot', {
    event: 'home-dress-fetched',
    hasWidget: Boolean(widgetUrl),
    hasCard: Boolean(cardUrl),
    hasCardVideo: Boolean(cardVideoUrl),
    hasScreen: Boolean(screenUrl),
    tagCount: tags.length,
  });

  return { widgetUrl, cardUrl, cardVideoUrl, screenUrl, tags };
}
