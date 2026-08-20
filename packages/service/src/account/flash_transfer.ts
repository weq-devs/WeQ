/**
 * FlashTransferService — QQ 闪传（flash transfer / fileset）分享链接。
 *
 * 与 PeerStatsService 同构：注入发生在账号 bootstrap，这里只负责在已注入的
 * 在线 pid 上发包（OIDB 0x93d3_1 GetFilesetDetail），把 filesetUuid 换成
 * 分享链接（qfile.qq.com/q/<code>）。QQ 离线 / 风控失败原样上抛，由 router
 * 统一转成用户提示。
 */
import type { AccountSession } from '@weq/account';
import type { NtHelperBinding } from '@weq/native';
import { GetFilesetDetail } from '@weq/protocol';

export class FlashTransferService {
  constructor(
    private readonly nt: Pick<NtHelperBinding, 'sendOidbPacket'>,
    _session: AccountSession,
    private readonly resolvePid: () => number,
  ) {}

  /** 用 filesetUuid 换取闪传分享链接（拿不到时为 ''）。 */
  async getShareLink(filesetUuid: string): Promise<string> {
    const entries = await GetFilesetDetail.invoke(this.nt, this.resolvePid(), {
      filesetUuid,
    });
    return entries.find((entry) => entry.shareUrl !== '')?.shareUrl ?? '';
  }
}
