/**
 * PeerStatsService — 他人的个性主页统计（QQ 等级 + 资料卡累计获赞）+ QQ 秀形象。
 *
 * 三个字段来自三条独立的 OIDB：
 *  - GetUserQqLevel (0xFE1_2) 按 **uin** 查 QQ 等级（只回 level，不回 uid）；
 *  - GetProfileLike  (0x7ED_12) 按 **uid** 查资料卡互动，取 `voteInfo.totalCount`
 *    作为累计获赞（其它字段如今日/新增/收藏不在本卡片展示范围内）；
 *  - GetQqShowUrl   (0xFE1_3) 按 **uin** 查 QQ 秀形象 URL（没有 QQ 秀时 hasShow=false）。
 *
 * 与 GroupAlbumMediaService 同构：attach 发生在账号 bootstrap，这里只负责在已 attach 的
 * 在线 pid 上发包，失败（QQ 离线 / 风控）原样上抛，由 router 统一转成用户提示。
 */
import type { AccountSession } from '@weq/account';
import type { ContactMetricsService } from './contact_metrics';
import type { NtHelperBinding } from '@weq/native';
import { GetProfileLike, GetQqShowUrl, GetUserQqLevel, SendProfileLike } from '@weq/protocol';
import type { QqShowInfo } from '@weq/protocol';

export interface PeerStats {
  /** QQ 等级（0xFE1_2 number-property 105），0 表示未命中/新号。 */
  level: number | null;
  /** 资料卡累计获赞；机器人与企业用户不适用，返回 null。 */
  likeCount: number | null;
}

export class PeerStatsService {
  contactMetrics?: ContactMetricsService;
  constructor(
    private readonly nt: Pick<NtHelperBinding, 'sendOidbPacket'>,
    private readonly session: AccountSession,
    private readonly resolvePid: () => number,
  ) {}

  /** 查目标 QQ 号的等级（0xFE1_2，按 uin 查，无需 uid）。 */
  async getQqLevel(uin: string, priority = 0): Promise<number> {
    if (this.contactMetrics)
      return this.contactMetrics.query(
        `friend:${uin}`,
        ['level'],
        async () =>
          (await GetUserQqLevel.invoke(this.nt, this.resolvePid(), { uin: Number(uin) })).level,
        (level) => ({ level }),
        priority,
      );
    const info = await GetUserQqLevel.invoke(this.nt, this.resolvePid(), {
      uin: Number(uin),
    });
    return info.level;
  }

  /** 查目标 uid 的累计获赞（0x7ED_12，只取 voteInfo.totalCount）。 */
  async getLikeCount(uid: string, priority = 0): Promise<number | null> {
    const profile = await this.session.profileInfo.getProfile(uid);
    if (profile?.isBot || profile?.extInfo?.isEnterprise) {
      await this.contactMetrics?.removeMetrics(
        [`friend:${uid}`, `friend:${profile.uin}`],
        ['likeCount'],
      );
      return null;
    }
    if (this.contactMetrics)
      return this.contactMetrics.query(
        `friend:${uid}`,
        ['likeCount'],
        async () => {
          const info = await GetProfileLike.invoke(this.nt, this.resolvePid(), { targetUid: uid });
          if (info.uid !== uid) throw new Error('资料卡获赞响应的目标 UID 不一致');
          return info.voteInfo.totalCount;
        },
        (likeCount) => ({ likeCount }),
        priority,
      );
    const info = await GetProfileLike.invoke(this.nt, this.resolvePid(), {
      targetUid: uid,
    });
    if (info.uid !== uid) throw new Error('资料卡获赞响应的目标 UID 不一致');
    return info.voteInfo.totalCount;
  }

  /** 不自动重试；累计获赞变化不是本次写入次数的独立证明。 */
  async sendLike(uid: string, count: number): Promise<'accepted' | 'unconfirmed'> {
    return SendProfileLike.invoke(this.nt, this.resolvePid(), { targetUid: uid, count });
  }

  /** 查目标 QQ 号的 QQ 秀形象（0xFE1_3，按 uin 查，返回透明全身像 URL）。 */
  async getQqShow(uin: string): Promise<QqShowInfo> {
    return GetQqShowUrl.invoke(this.nt, this.resolvePid(), { uin: Number(uin) });
  }

  /** 一并取 QQ 等级 + 累计获赞（两个包并行发）。 */
  async getPeerStats(
    uin: string,
    uid: string,
    fields: readonly ('level' | 'likeCount')[] = ['level', 'likeCount'],
  ): Promise<PeerStats> {
    const [level, likeCount] = await Promise.allSettled([
      fields.includes('level') ? this.getQqLevel(uin) : Promise.resolve(null),
      fields.includes('likeCount') ? this.getLikeCount(uid) : Promise.resolve(null),
    ]);
    if (level.status === 'rejected' && likeCount.status === 'rejected') throw level.reason;
    if (fields.length === 1 && fields[0] === 'level' && level.status === 'rejected')
      throw level.reason;
    if (fields.length === 1 && fields[0] === 'likeCount' && likeCount.status === 'rejected')
      throw likeCount.reason;
    return {
      level: level.status === 'fulfilled' ? level.value : null,
      likeCount: likeCount.status === 'fulfilled' ? likeCount.value : null,
    };
  }
}
