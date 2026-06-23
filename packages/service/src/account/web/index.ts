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

const QUN_DOMAIN = 'qun.qq.com';
const QZONE_DOMAIN = 'qzone.qq.com';

export class WebQueryService {
  private readonly creds: WebCredentialProvider;

  constructor(
    nt: Pick<NtHelperBinding, 'fetchSkey' | 'fetchPskey'>,
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
}

export { computeBkn, cookieHeader, WebCredentialProvider } from './credential';
export type { WebCredential } from './credential';
export { getGroupNotice } from './group_notice';
export type { GroupNotice, GroupNoticeImage } from './group_notice';
export { getGroupAlbumList } from './group_album';
export type { GroupAlbum } from './group_album';
export { getHonorList, HonorType } from './group_honor';
export type { HonorMember } from './group_honor';
