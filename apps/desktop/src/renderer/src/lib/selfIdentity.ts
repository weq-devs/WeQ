import type { User } from '../im-template/template/types';

/** 灰条 / 会话预览里「自己」那一半的显示文案。 */
export const SELF_LABEL = '你';

/**
 * 收集当前登录用户的全部身份串：`id`（`self:<uin>`）、`identityValue`（uin）、
 * `uid`（`u_…`）。
 *
 * 灰条（以及 40051 里的同款预览元素）对同一个人的节点有时写 uin、有时写 uid ——
 * 真机 C2C 戳一戳的 `<qq uin="u_…">` 里塞的其实就是 uid。只比对其中一个必然漏判，
 * 于是「自己」那半掉到昵称解析上，把自己的 QQ 号 / 裸 uid 原样渲染出来。三个都收
 * 进来做集合命中，任一相等即为自己。
 */
export function selfIdentityValues(user: User | null | undefined): string[] {
  if (!user) return [];
  const values = [user.id, user.identityValue, user.uid];
  return Array.from(
    new Set(
      values.filter((value): value is string => typeof value === 'string' && value.trim() !== ''),
    ),
  );
}

/** `value` 是否命中「自己」的身份集合（自动 trim，忽略空值）。 */
export function isSelfIdentity(
  self: ReadonlySet<string>,
  value: string | null | undefined,
): boolean {
  const key = String(value ?? '').trim();
  return key !== '' && self.has(key);
}
