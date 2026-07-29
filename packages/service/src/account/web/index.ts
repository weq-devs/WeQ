/**
 * Web cgi facade — query-only access to qq.com web endpoints for one account
 * session (group notice / album list / honor).
 */
import type { AccountSession } from '@weq/account';
import type { NtHelperBinding } from '@weq/native';
import { WebCredentialProvider } from './credential';
import { getFriendDress, type FriendDress } from './friend_dress';
import { getGroupAlbumList, type GroupAlbum } from './group_album';
import { getHonorList, type HonorType, type HonorMember } from './group_honor';
import { getGroupNotice, type GroupNotice } from './group_notice';
import {
  getQzoneMsgList,
  getQzoneFeeds,
  type QzoneMsgListResult,
  type QzoneFeedsResult,
} from './qzone';
import { getSelfDress, type SelfDress } from './self_dress';
import {
  getDressRank,
  searchDress,
  type DressAppId,
  type DressMallItem,
} from './dress_mall';

const QUN_DOMAIN = 'qun.qq.com';
const QZONE_DOMAIN = 'qzone.qq.com';
const VIP_DOMAIN = 'vip.qq.com';

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
    return getGroupNotice(await this.creds.forDomain(QUN_DOMAIN), groupCode);
  }

  async getGroupAlbumList(groupId: string): Promise<GroupAlbum[]> {
    return getGroupAlbumList(await this.creds.forDomain(QZONE_DOMAIN), groupId);
  }

  /** 查某人正在用的好友装扮(挂件/名片/来电/输入状态等)。解析不出返回 null。 */
  async getFriendDress(targetUin: string): Promise<FriendDress | null> {
    return getFriendDress(await this.creds.forDomain(VIP_DOMAIN), targetUin);
  }

  /** 查**本账号**正在用的全部装扮 —— 含查他人拿不到的气泡/字体。 */
  async getSelfDress(): Promise<SelfDress> {
    return getSelfDress(await this.creds.forDomain(VIP_DOMAIN));
  }

  /** 装扮商城排行榜。 */
  async getDressRank(
    appId: DressAppId,
    pageIndex = 1,
    pageSize = 20,
  ): Promise<DressMallItem[]> {
    return getDressRank(await this.creds.forDomain(VIP_DOMAIN), { appId, pageIndex, pageSize });
  }

  /** 装扮商城搜索。`pageIndex` 从 0 起(与排行榜不同,照接口)。 */
  async searchDress(
    appId: DressAppId,
    keyword: string,
    pageIndex = 0,
    pageSize = 40,
  ): Promise<{ items: DressMallItem[]; total: number }> {
    return searchDress(await this.creds.forDomain(VIP_DOMAIN), {
      appId,
      keyword,
      pageIndex,
      pageSize,
    });
  }

  async getHonorList(groupCode: string, type: HonorType): Promise<HonorMember[]> {
    return getHonorList(await this.creds.forDomain(QUN_DOMAIN), groupCode, type);
  }

  /** 某个空间的说说列表;`pos`+`num` 可稳定深翻历史。 */
  async getQzoneMsgList(targetUin: string, pos = 0, num = 20): Promise<QzoneMsgListResult> {
    return getQzoneMsgList(await this.creds.forDomain(QZONE_DOMAIN), targetUin, pos, num);
  }

  /** 好友动态(首页可靠;深翻页待游标分页)。`selfUin` 省略默认为本账号。 */
  async getQzoneFeeds(selfUin?: string, pageNum = 1, count = 10): Promise<QzoneFeedsResult> {
    const cred = await this.creds.forDomain(QZONE_DOMAIN);
    return getQzoneFeeds(cred, selfUin ?? cred.uin, pageNum, count);
  }
}

export { computeBkn, cookieHeader, WebCredentialProvider } from './credential';
export type { WebCredential } from './credential';
export { getFriendDress } from './friend_dress';
export type { FriendDress, FriendDressItem } from './friend_dress';
export { getSelfDress } from './self_dress';
export type { SelfDress, SelfDressItem } from './self_dress';
export { dressKind } from './dress_kind';
export { getGroupNotice } from './group_notice';
export type { GroupNotice, GroupNoticeImage } from './group_notice';
export { getGroupAlbumList } from './group_album';
export type { GroupAlbum } from './group_album';
export { getHonorList, HonorType } from './group_honor';
export type { HonorMember } from './group_honor';
export { getQzoneMsgList, getQzoneFeeds, mapMsgList, mapFeeds, parseQzoneJson, parseQzoneCallback } from './qzone';
export type {
  QzoneEmotion,
  QzoneMsgListResult,
  QzoneFeed,
  QzoneFeedsResult,
} from './qzone';
