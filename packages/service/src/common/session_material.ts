import type { SessionMaterial } from '@weq/native';

/** 与原生 SSO 登记共用校验，避免将非空但不可用的凭据当作就绪。 */
export function isCompleteSessionMaterial<T extends SessionMaterial>(
  material: T | null | undefined,
): material is T & Required<SessionMaterial> {
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
