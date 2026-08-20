/**
 * PeerStatsService — 他人的个性主页统计（QQ 等级 + 资料卡累计获赞）+ QQ 秀形象。
 *
 * 三个字段来自三条独立的 OIDB：
 *  - GetUserQqLevel (0xFE1_2) 按 **uin** 查 QQ 等级（只回 level，不回 uid）；
 *  - GetProfileLike  (0x7ED_12) 按 **uid** 查资料卡互动，取 `voteInfo.totalCount`
 *    作为累计获赞（其它字段如今日/新增/收藏不在本卡片展示范围内）；
 *  - GetQqShowUrl   (0xFE1_3) 按 **uin** 查 QQ 秀形象 URL（没有 QQ 秀时 hasShow=false）。
 *
 * 与 GroupAlbumMediaService 同构：注入发生在账号 bootstrap，这里只负责在已注入的
 * 在线 pid 上发包，失败（QQ 离线 / 风控）原样上抛，由 router 统一转成用户提示。
 */
import type { AccountSession } from '@weq/account';
import type { NtHelperBinding } from '@weq/native';
import { GetProfileLike, GetQqShowUrl, GetUserQqLevel } from '@weq/protocol';
import type { QqShowInfo } from '@weq/protocol';

export interface PeerStats {
  /** QQ 等级（0xFE1_2 number-property 105），0 表示未命中/新号。 */
  level: number;
  /** 资料卡累计获赞（0x7ED_12 voteInfo.totalCount）。 */
  likeCount: number;
}

export class PeerStatsService {
  constructor(
    private readonly nt: Pick<NtHelperBinding, 'sendOidbPacket'>,
    _session: AccountSession,
    private readonly resolvePid: () => number,
  ) {}

  /** 查目标 QQ 号的等级（0xFE1_2，按 uin 查，无需 uid）。 */
  async getQqLevel(uin: string): Promise<number> {
    const info = await GetUserQqLevel.invoke(this.nt, this.resolvePid(), {
      uin: Number(uin),
    });
    return info.level;
  }

  /** 查目标 uid 的累计获赞（0x7ED_12，只取 voteInfo.totalCount）。 */
  async getLikeCount(uid: string): Promise<number> {
    const info = await GetProfileLike.invoke(this.nt, this.resolvePid(), {
      targetUid: uid,
    });
    return info.voteInfo.totalCount;
  }

  /** 查目标 QQ 号的 QQ 秀形象（0xFE1_3，按 uin 查，返回透明全身像 URL）。 */
  async getQqShow(uin: string): Promise<QqShowInfo> {
    return GetQqShowUrl.invoke(this.nt, this.resolvePid(), { uin: Number(uin) });
  }

  /** 一并取 QQ 等级 + 累计获赞（两个包并行发）。 */
  async getPeerStats(uin: string, uid: string): Promise<PeerStats> {
    const [level, likeCount] = await Promise.all([this.getQqLevel(uin), this.getLikeCount(uid)]);
    return { level, likeCount };
  }
}
