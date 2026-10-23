/**
 * 会员身份的归一模型与本地兜底。
 *
 * 在线时由 `web/vip_info.ts` 从 club.vip 接口拿权威值；离线（QQ 没开、也
 * 没有落盘缓存）时从本地 `profile_info_v6` 的 21000 特权清单推断 —— 代价是
 * 拿不到年费标记（年费 tag 20449 在 codec 里尚未解析，文档标注也是「推测」）。
 */

import type { Privilege } from '@weq/db';
import type { NtHelperBinding } from '@weq/native';
import { WebCredentialProvider } from './web/credential';
import { fetchVipInfo } from './web/vip_info';

/** 会员档位，从高到低：大会员 > 超级会员 > 普通会员。 */
export type VipTier = 'vip' | 'svip' | 'bvip';

/** 一个账号的会员身份快照（JSON-safe，可直接进账号配置）。 */
export interface VipInfo {
  tier: VipTier;
  /** 年费。本地推断时恒为 false（拿不到权威标记）。 */
  year: boolean;
  /** 该档位的等级（普通 VIP 无独立等级，通常为 0）。 */
  level: number;
  /** 到期时间（unix 秒），尽力而为。 */
  expireAt?: number;
  /** 取到这份数据的时间（unix ms）。 */
  fetchedAt: number;
}

/** 本地特权清单里的业务 id：1 = 超级会员，113 = 大会员。 */
const BIZ_BVIP = 113;
const BIZ_SVIP = 1;

/**
 * 从 21000 特权清单推断会员身份。不是会员返回 null。
 *
 * 只认**已开通**的项：`gray_N` 的未开通项也会出现在清单里（见
 * `docs/database/profile_info/profile-info-v6.md`），不能只看 bizId。
 *
 * 普通 VIP（红）在 21000 里没有对应的 bizId —— 命中的只有超会和大会员，
 * 所以离线兜底只能给出这两档。
 */
export function vipInfoFromPrivileges(
  privileges: readonly Privilege[] | undefined,
  now = Date.now(),
): VipInfo | null {
  const opened = (privileges ?? []).filter((p) => p.opened);
  const bvip = opened.find((p) => p.bizId === BIZ_BVIP);
  if (bvip) return { tier: 'bvip', year: false, level: bvip.level ?? 0, fetchedAt: now };
  const svip = opened.find((p) => p.bizId === BIZ_SVIP);
  if (svip) return { tier: 'svip', year: false, level: svip.level ?? 0, fetchedAt: now };
  return null;
}

/**
 * 顶栏徽标要用的会员身份：在线结论 → 本地兜底 → 什么都不显示。
 *
 * 三种「没有 vip 快照」的情形必须分开，这是这个函数存在的唯一理由：
 *
 *   | `vip` | `vipCheckedAt` | 含义              | 结果         |
 *   | ----- | -------------- | ----------------- | ------------ |
 *   | 有    | —              | 在线确认是会员     | 直接用它     |
 *   | 无    | 有             | 在线确认**不是**会员 | null（不退回本地） |
 *   | 无    | 无             | 从没查过            | 本地特权清单兜底 |
 *
 * 中间那一行最容易写错：退会以后本地 `profile_info_v6` 还是旧的「超会」，
 * 退回它会把徽标又顶回来。
 */
export function resolveVipBadge(input: {
  vip?: VipInfo | null;
  vipCheckedAt?: number | null;
  privileges?: readonly Privilege[] | null;
  now?: number;
}): VipInfo | null {
  if (input.vip) return input.vip;
  if (input.vipCheckedAt) return null;
  return vipInfoFromPrivileges(input.privileges ?? undefined, input.now);
}

/** vip.qq.com 的域。登录流程默认就会取它（见 bootstrap/key.ts 的 PSKEY_DOMAINS）。 */
export const VIP_PSKEY_DOMAIN = 'vip.qq.com';

/** 抓一次会员信息需要的最小原生面与账号上下文。 */
export interface FetchAccountVipOptions {
  nt: Pick<NtHelperBinding, 'ptFetchCredentials'>;
  uin: string;
  /**
   * 在线 QQ 的 pid；`0` 表示离线。离线时只能用 `seedPskey` 里那枚票据 ——
   * 「WeQ 先启动、QQ 后上线」之外的所有场景都靠它。
   */
  pid: number;
  /** 落盘的登录票据（`AccountConfig.loginPskey`）。 */
  seedPskey?: Record<string, string>;
  /** seed 票据被判失效时回调（让落盘那份也删掉）。 */
  onSeedInvalidated?: (domain: string) => void;
  /** 现在（unix ms），仅测试用。 */
  now?: number;
}

/**
 * 拿本账号的会员身份（在线优先，离线可只用 seed 票据）。不是会员返回 null。
 *
 * 换票策略与首页装扮一致：先用 seed（省一次 hook 往返，QQ 没开也能走），失败且
 * QQ 在线时丢掉 seed 走活 hook 重试一次。
 *
 * 抽在 service 层而不是桌面主进程：它只依赖 native 的 `ptFetchCredentials`，
 * 桌面端与 Web 端都能复用，主进程那边只剩「什么时候刷新」。
 */
export async function fetchAccountVipInfo(
  options: FetchAccountVipOptions,
): Promise<VipInfo | null> {
  const { nt, uin, pid, seedPskey, onSeedInvalidated, now } = options;
  const seed = seedPskey?.[VIP_PSKEY_DOMAIN];

  const credential = (useSeed: boolean) => {
    const provider = new WebCredentialProvider(nt, uin, () => pid, onSeedInvalidated);
    if (useSeed && seed) provider.seedPskey({ [VIP_PSKEY_DOMAIN]: seed });
    return provider.forDomain(VIP_PSKEY_DOMAIN);
  };

  if (seed) {
    try {
      return await fetchVipInfo(await credential(true), now);
    } catch (error) {
      // 没在线实例时换不出新票，直接把这个错误交给调用方（离线 + 票据过期）。
      if (pid <= 0) throw error;
      onSeedInvalidated?.(VIP_PSKEY_DOMAIN);
    }
  }
  if (pid <= 0) throw new Error('QQ 未在线，没有可用于会员信息的 Web 票据。');
  return fetchVipInfo(await credential(false), now);
}
