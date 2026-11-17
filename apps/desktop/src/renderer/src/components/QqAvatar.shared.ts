/**
 * QQ avatar with graceful fallback to a user glyph. Resolves the public CDN
 * URL from a uin when no explicit URL is given.
 */

export function qqAvatarUrl(uin: string): string {
  return `https://thirdqq.qlogo.cn/g?b=sdk&nk=${uin}&s=0`;
}
