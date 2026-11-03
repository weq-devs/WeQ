/**
 * 一次性迁移：纠正旧版安卓备份账号记录里可能被猜错的 uin。
 *
 * 旧版从 `profile_info.db` 的 `profile_info_vN` 表按 `1002` 列查本人 uin，没有
 * 身份提示时还靠 `ORDER BY "20003" DESC` 猜那一行 —— 资料库是缓存表，本人行可能
 * 缺失、陈旧，也可能被更新时间更晚的联系人抢占。猜错的 uin 会被写进账号记录，
 * 而 `configId = ${uin}_${hash(dataDir)}`，于是该账号所有按 id 隔离的数据都
 * 挂在了错误的键上。
 *
 * 现在密钥推导链（`gpro` 文件名 / `login.db` 行）与消息库自证能给出权威身份，
 * 这里在启动时逐个复核静态记录：发现不一致就改写记录 + 搬迁派生目录。
 *
 * 只在能**确定新身份**时才动：拿不到密钥（明文库除外）、探测失败、推导不出 uin
 * 一律跳过，绝不在证据不足时改写用户数据。
 */

import { existsSync } from 'node:fs';
import type { UserConfigService, AccountConfig } from '@weq/service';
import { accountConfigId, loginDbPaths } from '@weq/service';
import type { Platform } from '@weq/platform';
import { runBackupProbe } from './backup_probe';

export interface IdentityMigrationResult {
  /** 复核过的静态记录数。 */
  checked: number;
  /** 实际纠正并搬迁的账号。 */
  corrected: Array<{ from: string; to: string; oldUin: string; newUin: string }>;
}

/** 只有静态账号的 uin 来自资料库猜测，在线账号不受影响。 */
function isStaticRecord(record: AccountConfig): boolean {
  return record.static === true && !!record.dataDir;
}

/**
 * 复核并纠正所有静态账号记录的 uin。best-effort：单条失败只跳过，绝不抛出。
 *
 * 幂等：纠正后记录里的 uin / configId 都是新的，下次运行自然不再命中。
 */
export async function migrateStaticAccountIdentity(
  platform: Platform,
  userConfig: UserConfigService,
): Promise<IdentityMigrationResult> {
  const result: IdentityMigrationResult = { checked: 0, corrected: [] };
  let loginDb: string[] = [];
  try {
    loginDb = loginDbPaths(platform);
  } catch {
    loginDb = [];
  }

  for (const record of userConfig.listAccountConfigs()) {
    if (!isStaticRecord(record)) continue;
    const dirPath = record.dataDir!;
    // 目录已经不在（用户删了备份 / 换了位置）就没有可复核的对象。
    if (!existsSync(dirPath)) continue;
    result.checked++;
    try {
      const probe = await runBackupProbe({
        dirPath,
        ...(record.dbKey ? { dbKey: record.dbKey } : {}),
        ...(loginDb.length ? { loginDbPaths: loginDb } : {}),
      });
      // 需要密钥 / 探测失败：证据不足，保持记录原样。
      if (probe.status !== 'ready') continue;
      const uin = probe.preview.uin;
      if (!uin || uin === record.uin) continue;

      const configId = accountConfigId(uin, dirPath);
      const renamed = userConfig.renameAccountConfigId(record.configId, {
        uin,
        configId,
        ...(probe.preview.uid ? { uid: probe.preview.uid } : {}),
      });
      if (!renamed) continue;
      result.corrected.push({
        from: record.configId,
        to: renamed,
        oldUin: record.uin,
        newUin: uin,
      });
    } catch {
      // 单条失败（目录只读、原生异常…）不影响其它账号。
    }
  }
  return result;
}
