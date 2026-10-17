/**
 * native 构建有效期的纯计算（无 IO）。
 *
 * **有效期天数不在这里定义**：`nt_helper.node` 自己通过 `getBuildInfo()` 报出
 * `buildTime` / `expireTime` / `validitySecs`，这里只做「还剩多少 / 是否偏旧」的折算。
 * 未来有效期从 30 天改成 45 天，这个文件一行都不用动。
 *
 * 被两处共用：
 *   - `scripts/fetch-native.mjs`（拉取时判断新鲜度、往锚文件写日期）
 *   - `packages/native/test/validity.test.ts`（单测）
 */

/**
 * 新鲜度阈值（**占有效期的比例**，不是天数）。
 * 剩余不足 1/5 视为「快过期」—— `--require-fresh` 据此失败，其余路径据此提醒。
 */
export const FRESH_MIN_REMAINING_RATIO = 1 / 5;

const DAY_MS = 86_400_000;

/**
 * 把「构建时间 / 过期时间 / 有效期长度」折算成剩余时间与百分比。
 *
 * 所有字段都可能缺失（老 `.node` 没有 `getBuildInfo()`，老 manifest 没有
 * `expiresAt`）—— 缺失时 `known` 为 false，调用方只提醒、不据此失败。
 *
 * @param {{ buildTimeMs?: number, expireTimeMs?: number, validityMs?: number }} input 单位毫秒
 * @param {number} [nowMs] 当前时间（测试注入）
 */
export function validityOf({ buildTimeMs, expireTimeMs, validityMs }, nowMs = Date.now()) {
  const known = Number.isFinite(expireTimeMs);
  const total =
    Number.isFinite(validityMs) && validityMs > 0
      ? validityMs
      : Number.isFinite(buildTimeMs) && known
        ? expireTimeMs - buildTimeMs
        : undefined;
  const remainingMs = known ? expireTimeMs - nowMs : undefined;
  const remainingRatio =
    remainingMs !== undefined && total !== undefined && total > 0 ? remainingMs / total : undefined;
  return {
    known,
    expired: known ? remainingMs <= 0 : false,
    remainingMs,
    remainingDays: remainingMs === undefined ? undefined : remainingMs / DAY_MS,
    remainingRatio,
    totalDays: total === undefined ? undefined : total / DAY_MS,
    buildAt: Number.isFinite(buildTimeMs) ? new Date(buildTimeMs).toISOString() : null,
    expireAt: known ? new Date(expireTimeMs).toISOString() : null,
  };
}

/** 剩余有效期是否已经偏低（比例阈值）；时间未知时返回 false。 */
export function isStale(validity) {
  return (
    validity.remainingRatio !== undefined && validity.remainingRatio < FRESH_MIN_REMAINING_RATIO
  );
}

/** 「还剩 3.2 天（有效期 30 天）」这种给人看的措辞；未知时返回 null。 */
export function validityText(validity) {
  if (validity.remainingDays === undefined) return null;
  const left = validity.remainingDays;
  const total = validity.totalDays === undefined ? null : `${validity.totalDays.toFixed(0)} 天`;
  if (left <= 0) return total ? `已过期（有效期 ${total}）` : '已过期';
  return total ? `还剩 ${left.toFixed(1)} 天（有效期 ${total}）` : `还剩 ${left.toFixed(1)} 天`;
}

/**
 * 从 manifest + 二进制自报的 `getBuildInfo()` 汇总有效期视图。
 *
 * 二进制是权威（`expireTime` 由 `BUILD_TIMESTAMP` 加 native 侧那段有效期算出）；
 * manifest 里的 `expiresAt` 只是同一事实的转抄。两边都有以二进制为准，只有 manifest
 * 时（离线 / 未装 `.node`）退而用它。
 *
 * @param {any} manifest manifest.json（`buildTime` / `builtAt` / `expiresAt` 均为 ISO）
 * @param {{buildTime?: number, expireTime?: number, validitySecs?: number}} [binaryInfo] getBuildInfo() 的返回（秒）
 * @param {number} [nowMs]
 */
export function manifestValidity(manifest, binaryInfo, nowMs = Date.now()) {
  const toMs = (iso) => {
    const at = Date.parse(iso ?? '');
    return Number.isFinite(at) ? at : undefined;
  };
  const buildTimeMs = Number.isFinite(binaryInfo?.buildTime)
    ? binaryInfo.buildTime * 1000
    : (toMs(manifest?.buildTime) ?? toMs(manifest?.builtAt));
  const expireTimeMs = Number.isFinite(binaryInfo?.expireTime)
    ? binaryInfo.expireTime * 1000
    : toMs(manifest?.expiresAt);
  const validityMs = Number.isFinite(binaryInfo?.validitySecs)
    ? binaryInfo.validitySecs * 1000
    : undefined;
  return validityOf({ buildTimeMs, expireTimeMs, validityMs }, nowMs);
}
