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
import { WebCredentialProvider, withRetry, type WebNative } from './credential';
import { getFriendDress, type FriendDress } from './friend_dress';
import { getGroupAlbumList, type GroupAlbum } from './group_album';
import {
  getQzoneAlbumList,
  getQzoneAlbumMedia,
  getQzoneAlbumVideoUrl,
  type QzoneAlbum,
  type QzoneAlbumMediaResult,
} from './qzone_album';
import { getGroupNotice, type GroupNotice } from './group_notice';
import { getGroupEssence, type GroupEssenceMessage } from './group_essence';
import { getHonorList, type HonorType, type HonorMember } from './group_honor';
import {
  getQzoneMsgList,
  getQzoneFeeds,
  type QzoneMsgListResult,
  type QzoneFeedsResult,
} from './qzone';
import {
  collectQzoneInteractions,
  fetchQzoneLikes,
  type QzoneInteraction,
  type QzoneInteractionTarget,
  type QzoneLike,
} from './qzone_interaction';
import { getSelfDress, type SelfDress } from './self_dress';
import { getFriendMutualMark, type FriendMutualMark } from './friend_mutualmark';
import { getDressRank, searchDress, type DressAppId, type DressMallItem } from './dress_mall';

const QUN_DOMAIN = 'qun.qq.com';
const QZONE_DOMAIN = 'qzone.qq.com';
const VIP_DOMAIN = 'vip.qq.com';
const TI_DOMAIN = 'ti.qq.com';

export class WebQueryService {
  private readonly creds: WebCredentialProvider;

  constructor(nt: WebNative, session: AccountSession, resolvePid: () => number) {
    this.creds = new WebCredentialProvider(nt, session.context.uin, resolvePid);
  }

  async getGroupNotice(groupCode: string): Promise<GroupNotice[]> {
    return withRetry(this.creds, QUN_DOMAIN, (c) => getGroupNotice(c, groupCode));
  }

  async getGroupEssence(
    groupCode: string,
    pageStart = 0,
    pageLimit = 50,
  ): Promise<GroupEssenceMessage[]> {
    return withRetry(this.creds, QUN_DOMAIN, (c) =>
      getGroupEssence(c, groupCode, pageStart, pageLimit),
    );
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

  /**
   * Best-effort 读取某空间若干说说的评论 + 点赞（空间动态页 HTML 解析）。
   * 供好友空间导出「补全互动」使用；互动缺失不抛错(空桶)，拉取失败抛错。
   */
  async getQzoneInteractions(
    targetUin: string,
    targets: QzoneInteractionTarget[],
  ): Promise<Map<string, QzoneInteraction>> {
    return withRetry(this.creds, QZONE_DOMAIN, (c) =>
      collectQzoneInteractions(c, targetUin, targets),
    );
  }

  /**
   * 读某条说说的点赞名单（r.qzone qz_opcnt2，结构化 uin+昵称）。
   * 比动态页 HTML 里的 user-list 稳定（HTML 偶发不渲染名单）。
   */
  async getQzoneLikes(targetUin: string, tid: string): Promise<QzoneLike[]> {
    return withRetry(this.creds, QZONE_DOMAIN, (c) => fetchQzoneLikes(c, targetUin, tid));
  }

  /** 某 QQ 空间（自己或好友）的相册列表。 */
  async getQzoneAlbums(targetUin: string): Promise<QzoneAlbum[]> {
    return withRetry(this.creds, QZONE_DOMAIN, (c) => getQzoneAlbumList(c, targetUin));
  }

  /** 某相册内媒体（照片/视频）列表；`topicId` = 相册列表里的 `album.id`。 */
  async getQzoneAlbumPhotos(
    targetUin: string,
    topicId: string,
    pageStart = 0,
    pageNum = 30,
  ): Promise<QzoneAlbumMediaResult> {
    return withRetry(this.creds, QZONE_DOMAIN, (c) =>
      getQzoneAlbumMedia(c, targetUin, topicId, pageStart, pageNum),
    );
  }

  /** 相册视频本体 mp4 URL（列表只给封面，本体按 picKey 另查）。 */
  async getQzoneAlbumVideoUrl(targetUin: string, topicId: string, picKey: string): Promise<string> {
    return withRetry(this.creds, QZONE_DOMAIN, (c) =>
      getQzoneAlbumVideoUrl(c, targetUin, topicId, picKey),
    );
  }
}

export {
  PT_LOGIN_DOMAINS,
  fetchSkeyViaPtLogin,
  fetchPskeyViaPtLogin,
  fetchWebTokens,
  computeBkn,
  cookieHeader,
  WebAuthError,
  WebCredentialProvider,
  withRetry,
} from './credential';
export type { WebCredential } from './credential';
export type { WebTokens } from './credential';
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
  QzoneEmotionVideo,
  QzoneMsgListResult,
  QzoneFeed,
  QzoneFeedsResult,
} from './qzone';
export { getQzoneAlbumList, getQzoneAlbumMedia, getQzoneAlbumVideoUrl } from './qzone_album';
export type { QzoneAlbum, QzoneAlbumPhoto, QzoneAlbumMediaResult } from './qzone_album';
export {
  collectQzoneInteractions,
  fetchQzoneLikes,
  parseFeeds3Comments,
  parseFeeds3Likes,
} from './qzone_interaction';
export type {
  QzoneComment,
  QzoneLike,
  QzoneInteraction,
  QzoneInteractionTarget,
} from './qzone_interaction';
