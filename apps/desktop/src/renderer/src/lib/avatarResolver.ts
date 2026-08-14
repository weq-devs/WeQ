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
export function avatarFromGroupCode(code: string | undefined | null, size: 0 | 100 = 0): string | null {
  if (!code) return null;
  return `https://p.qlogo.cn/gh/${code}/${code}/${size}`;
}

/**
 * 修复 profile_info.db 里的头像 URL（20004 列）。
 * 数据库里存的是 `http://qh.qlogo.cn/g?b=qq&ek=...&s=`，
 * 需要补全为 `&s=0` 才能访问。
 */
function fixProfileAvatarUrl(url: string | undefined | null): string | null {
  if (!url) return null;

  // 只处理 qh.qlogo.cn 的 URL
  if (!url.includes('qh.qlogo.cn')) return url;

  // 如果已经有 s=数字，直接返回
  if (/[?&]s=\d/.test(url)) return url;

  // 补全 &s=0（数据库里通常是 &s= 结尾）
  return url.replace(/([?&]s=)$/, '$10');
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
