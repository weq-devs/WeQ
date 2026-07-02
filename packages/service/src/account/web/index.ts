/**
 * Web cgi facade — query-only access to qq.com web endpoints for one account
 * session (group notice / album list / honor).
 */
import type { AccountSession } from '@weq/account';
import type { NtHelperBinding } from '@weq/native';
import { WebCredentialProvider } from './credential';
import { getGroupAlbumList, type GroupAlbum } from './group_album';
import { getHonorList, HonorType, type HonorMember } from './group_honor';
import { getGroupNotice, type GroupNotice } from './group_notice';
import {
  getQzoneMsgList,
  getQzoneFeeds,
  type QzoneMsgListResult,
  type QzoneFeedsResult,
} from './qzone';

const QUN_DOMAIN = 'qun.qq.com';
const QZONE_DOMAIN = 'qzone.qq.com';

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
