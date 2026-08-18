/**
 * Web cgi facade — query-only access to qq.com web endpoints for one account
 * session (group notice / album list / honor).
 *
 * 这个实例是**跟着账号会话活一整场**的(见 app_context 的服务装配),而 p_skey /
 * cookie jar 在服务端是短命的 —— 所以每个方法都套 {@link withRetry}:cgi 说票据不对
 * (抛 WebAuthError)就清掉该域的缓存、换一套新的重跑一次。不按时间戳猜过期,由 cgi
 * 自己告诉我们,这样既不多打 hook 也没有过期窗口。
 *
 * 前提是各 cgi 包装函数会在票据失效时抛 WebAuthError 而不是静默返回空值 ——
 * 群相册踩过这个坑(过期回的是 200 + code:-3000,被当成「这个群没有相册」)。
 */
import type { AccountSession } from '@weq/account';
import type { NtHelperBinding } from '@weq/native';
import { WebCredentialProvider, withRetry } from './credential';
import { getFriendDress, type FriendDress } from './friend_dress';
import { getGroupAlbumList, type GroupAlbum } from './group_album';
import { getHonorList, type HonorType, type HonorMember } from './group_honor';
import { getGroupNotice, type GroupNotice } from './group_notice';
import { getGroupEssence, type GroupEssenceMessage } from './group_essence';
import {
  getQzoneMsgList,
  getQzoneFeeds,
  type QzoneMsgListResult,
  type QzoneFeedsResult,
} from './qzone';
import { getSelfDress, type SelfDress } from './self_dress';
import { getFriendMutualMark, type FriendMutualMark } from './friend_mutualmark';
import { getDressRank, searchDress, type DressAppId, type DressMallItem } from './dress_mall';

const QUN_DOMAIN = 'qun.qq.com';
const QZONE_DOMAIN = 'qzone.qq.com';
const VIP_DOMAIN = 'vip.qq.com';
const TI_DOMAIN = 'ti.qq.com';

export class WebQueryService {
  private readonly creds: WebCredentialProvider;

  constructor(
    nt: Pick<NtHelperBinding, 'fetchSkey' | 'fetchPskey' | 'fetchClientKey'>,
    session: AccountSession,
    resolvePid: () => number,
  ) {
    this.creds = new WebCredentialProvider(nt, session.context.uin, resolvePid);
  }

  async getGroupNotice(groupCode: string): Promise<GroupNotice[]> {
    return withRetry(this.creds, QUN_DOMAIN, (c) => getGroupNotice(c, groupCode));
  }

  async getGroupEssence(groupCode: string, pageStart = 0, pageLimit = 50): Promise<GroupEssenceMessage[]> {
    return withRetry(this.creds, QUN_DOMAIN, (c) => getGroupEssence(c, groupCode, pageStart, pageLimit));
  }

  async getGroupAlbumList(groupId: string): Promise<GroupAlbum[]> {
    return withRetry(this.creds, QZONE_DOMAIN, (c) => getGroupAlbumList(c, groupId));
  }

  /** 查某人正在用的好友装扮(挂件/名片/来电/输入状态等)。解析不出返回 null。 */
  async getFriendDress(targetUin: string): Promise<FriendDress | null> {
    return withRetry(this.creds, VIP_DOMAIN, (c) => getFriendDress(c, targetUin));
  }

  /** 查**本账号**正在用的全部装扮 —— 含查他人拿不到的气泡/字体。 */
  async getSelfDress(): Promise<SelfDress> {
    return withRetry(this.creds, VIP_DOMAIN, (c) => getSelfDress(c));
  }

  /** 查 `targetUin` 与你之间的互动标识(任务进度/关系标识),按 ti.qq.com 域取 skey/pskey。 */
  async getFriendMutualMark(targetUin: string): Promise<FriendMutualMark> {
    return withRetry(this.creds, TI_DOMAIN, (c) => getFriendMutualMark(c, targetUin));
  }

  /** 装扮商城排行榜。 */
  async getDressRank(appId: DressAppId, pageIndex = 1, pageSize = 20): Promise<DressMallItem[]> {
    return withRetry(this.creds, VIP_DOMAIN, (c) =>
      getDressRank(c, { appId, pageIndex, pageSize }),
    );
  }

  /** 装扮商城搜索。`pageIndex` 从 0 起(与排行榜不同,照接口)。 */
  async searchDress(
    appId: DressAppId,
    keyword: string,
    pageIndex = 0,
    pageSize = 40,
  ): Promise<{ items: DressMallItem[]; total: number }> {
    return withRetry(this.creds, VIP_DOMAIN, (c) =>
      searchDress(c, { appId, keyword, pageIndex, pageSize }),
    );
  }

  async getHonorList(groupCode: string, type: HonorType): Promise<HonorMember[]> {
    return withRetry(this.creds, QUN_DOMAIN, (c) => getHonorList(c, groupCode, type));
  }

  /** 某个空间的说说列表;`pos`+`num` 可稳定深翻历史。 */
  async getQzoneMsgList(targetUin: string, pos = 0, num = 20): Promise<QzoneMsgListResult> {
    return withRetry(this.creds, QZONE_DOMAIN, (c) => getQzoneMsgList(c, targetUin, pos, num));
  }

  /** 好友动态(首页可靠;深翻页待游标分页)。`selfUin` 省略默认为本账号。 */
  async getQzoneFeeds(selfUin?: string, pageNum = 1, count = 10): Promise<QzoneFeedsResult> {
    return withRetry(this.creds, QZONE_DOMAIN, (c) =>
      getQzoneFeeds(c, selfUin ?? c.uin, pageNum, count),
    );
  }
}

export {
  computeBkn,
  cookieHeader,
  WebAuthError,
  WebCredentialProvider,
  withRetry,
} from './credential';
export type { WebCredential } from './credential';
export { getFriendDress } from './friend_dress';
export type { FriendDress, FriendDressItem } from './friend_dress';
export { getSelfDress } from './self_dress';
export { getFriendMutualMark } from './friend_mutualmark';
export type {
  FriendMutualMark,
  FriendMarkCategory,
  FriendMark,
  FriendMarkLevel,
} from './friend_mutualmark';
export type { SelfDress, SelfDressItem } from './self_dress';
export { dressKind } from './dress_kind';
export { getGroupNotice } from './group_notice';
export type { GroupNotice, GroupNoticeImage } from './group_notice';
export { getGroupEssence } from './group_essence';
export type { GroupEssenceMessage, GroupEssenceContent } from './group_essence';
export { getGroupAlbumList } from './group_album';
export type { GroupAlbum } from './group_album';
export { getHonorList, HonorType } from './group_honor';
export type { HonorMember } from './group_honor';
export {
  getQzoneMsgList,
  getQzoneFeeds,
  mapMsgList,
  mapFeeds,
  parseQzoneJson,
  parseQzoneCallback,
} from './qzone';
export type {
  QzoneEmotion,
  QzoneMsgListResult,
  QzoneFeed,
  QzoneFeedsResult,
} from './qzone';
