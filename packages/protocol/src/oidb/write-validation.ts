/** 写操作参数必须在编码前拒绝，避免整数截断后作用于其他目标。 */
export function requireUint32(value: number, name: string, allowZero = false): number {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > 0xffffffff)
    throw new Error(`${name} 必须是有效的 uint32`);
  return value;
}

export function requireUid(value: string): string {
  if (!/^u_[A-Za-z0-9_-]+$/.test(value)) throw new Error('目标 UID 无效');
  return value;
}

export function requireUin(value: string): bigint {
  if (!/^[1-9]\d*$/.test(value)) throw new Error('账号 UIN 无效');
  const uin = BigInt(value);
  if (uin > 0xffffffffffffffffn) throw new Error('账号 UIN 超出 uint64');
  return uin;
}

export function responseObject(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${name} 响应缺失或无效`);
  return value as Record<string, unknown>;
}
