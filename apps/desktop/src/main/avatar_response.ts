import { createHash } from 'node:crypto';
import { matchesIfNoneMatch } from './protocol_response';

/** 头像按实际内容校验；显式换图不复用旧验证结果，过期后未变则只回 304。 */
export function avatarResponse(
  blob: { data: Uint8Array; contentType: string },
  request?: Request,
): Response {
  const etag = `"${createHash('sha256').update(blob.data).digest('base64url')}"`;
  const headers = {
    'Content-Type': blob.contentType,
    'Cache-Control': 'private, max-age=300',
    ETag: etag,
  };
  const refresh = request && new URL(request.url).searchParams.get('_weq_avatar_remote') === '1';
  const matches = matchesIfNoneMatch(request?.headers.get('if-none-match') ?? null, etag);
  if (!refresh && matches) return new Response(null, { status: 304, headers });
  return new Response(new Uint8Array(blob.data), { headers });
}
