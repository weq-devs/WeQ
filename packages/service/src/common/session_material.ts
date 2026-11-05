import type { SessionMaterial } from '@weq/native';

/**
 * 与原生 SSO 登记共用校验，避免将非空但不可用的凭据当作就绪。
 *
 * **只校验发包必需的三项**（a2 / d2 / d2key）：`SecToken` 是「有更好」的附加
 * 物料，扫不到时签名会退回不含 token 的旧行为，不该因此判定整份物料不可用。
 * 想判断能不能直接复用来登记 SSO，请用 {@link canReuseSessionMaterial}。
 */
export function isCompleteSessionMaterial<T extends SessionMaterial>(
  material: T | null | undefined,
): material is T & Required<Pick<SessionMaterial, 'a2' | 'd2' | 'd2Key'>> {
  const validHex = (value: string | undefined): value is string =>
    typeof value === 'string' && /^(?:[0-9a-fA-F]{2})+$/.test(value);
  return Boolean(
    material &&
      validHex(material.a2) &&
      validHex(material.d2) &&
      validHex(material.d2Key) &&
      material.d2Key.length === 32,
  );
}

/**
 * 本地缓存的物料能否直接复用（不再读内存）。
 *
 * 在 {@link isCompleteSessionMaterial} 之上多要求 `SecToken`：老版本存下的
 * 物料没有它，如果照旧复用，用户升级后签名依然缺 token，直到 QQ 重启或物料
 * 失效才自愈 —— 升级后「看起来没生效」。缺 token 时宁可重扫一次（约 2 秒）。
 *
 * 注意 `secToken` 只对**需要签名的命令**有意义；不需要签名的场景复用与否
 * 不影响正确性，但重扫本身没有副作用，所以不为此再分一档。
 */
export function canReuseSessionMaterial<T extends SessionMaterial>(
  material: T | null | undefined,
): material is T & Required<Pick<SessionMaterial, 'a2' | 'd2' | 'd2Key' | 'secToken'>> {
  return (
    isCompleteSessionMaterial(material) &&
    typeof material.secToken === 'string' &&
    material.secToken.length > 0
  );
}
