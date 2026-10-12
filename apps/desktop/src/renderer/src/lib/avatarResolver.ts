/**
 * 统一的头像 URL 解析逻辑。
 *
 * 优先级：
 * 1. 有 uin → 直接从 QQ CDN 拼接（最可靠）
 * 2. 有 profile.avatarUrl → 修复后使用（补全 &s=0 参数）
 * 3. 都没有 → 返回 null（组件 fallback 到默认图标）
 */

/**
 * 从 uin 生成 QQ 头像 CDN URL。
 * @param uin QQ 号（字符串格式）
 * @param size 尺寸：0=原图，100=小图（用于列表/关系图谱）
 */
export function avatarFromUin(uin: string | undefined | null, size: 0 | 100 = 0): string | null {
  if (!uin || uin === '0') return null;
  return `https://thirdqq.qlogo.cn/g?b=sdk&s=${size}&nk=${uin}`;
}

/**
 * 从群号生成群头像 CDN URL。
 */
export function avatarFromGroupCode(
  code: string | undefined | null,
  size: 0 | 100 = 0,
): string | null {
  if (!code) return null;
  return `https://p.qlogo.cn/gh/${code}/${code}/${size}`;
}

/**
 * 修复 QQ「profile 风格」头像 URL 末尾那个空的 `s=`。
 *
 * 这个形状到处都有 —— `profile_info.db` 的 20004 列，以及 OIDB 回包里的 headUrl
 * （如 0x9083 回应人名单的 `headUrl`），都是
 * `http://qh.qlogo.cn/g?b=qq&ek=...&s=`：**`s=` 是空的**，直接请求上游会 400（
 * 经 `weq-avatar://` 代理时表现为 502 Bad Gateway）→ 头像全裂。补成 `&s=0`（原图）
 * 就能正常取到。渲染层 CSP 已放行 qh.qlogo.cn，修复后可直接作为 `<img>` 源。
 *
 * 只动「s 为空」这一种情况：已经有 `s=<数字>` 的一律原样返回；非 qh.qlogo.cn 的
 * URL 也不碰。已由 {@link cachedAvatarUrl}（`lib/avatarCache.ts`）在渲染侧统一施加，
 * 所以调用方一般不需要自己再调。
 */
export function fixProfileAvatarUrl(url: string | undefined | null): string | null {
  if (!url) return null;

  // 只处理 qh.qlogo.cn 的 URL
  if (!url.includes('qh.qlogo.cn')) return url;

  // 如果已经有 s=数字，直接返回
  if (/[?&]s=\d/.test(url)) return url;

  // 补全 s=0。`(?=$|&)` 让 `&s=` 不在末尾（后面还跟着别的参数）时也能补。
  return url.replace(/([?&]s=)(?=$|&)/, (match) => `${match}0`);
}

/**
 * 统一的头像解析函数。
 *
 * @param opts.uin QQ 号（优先使用）
 * @param opts.profileAvatarUrl profile.avatarUrl（数据库 20004 列）
 * @param opts.size 尺寸：0=原图，100=小图
 * @returns 可用的头像 URL，或 null（需 fallback 到默认图标）
 *
 * @example
 * // 有 uin 的情况（最常见）
 * const url = resolveAvatar({ uin: '123456' });
 *
 * // 只有 uid，通过 profile 拿头像
 * const profile = profileByUid.get(uid);
 * const url = resolveAvatar({ uin: profile?.uin, profileAvatarUrl: profile?.avatarUrl });
 */
export function resolveAvatar(opts: {
  uin?: string | null;
  profileAvatarUrl?: string | null;
  size?: 0 | 100;
}): string | null {
  const { uin, profileAvatarUrl, size = 0 } = opts;

  // 优先：直接从 uin 拼接 CDN URL（最可靠）
  if (uin && uin !== '0') {
    return avatarFromUin(uin, size);
  }

  // 降级：修复 profile.avatarUrl（可能需要补全参数）
  if (profileAvatarUrl) {
    return fixProfileAvatarUrl(profileAvatarUrl);
  }

  // 无可用头像
  return null;
}
