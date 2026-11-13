/**
 * Add the response-side half of custom-protocol CORS support.
 *
 * In dev the renderer runs on `http://localhost:5173`, while `weq-media://` and
 * `weq-asset://` are different origins. Enabling `corsEnabled` on the privileged
 * scheme allows Chromium to consider the request cross-origin; responses still
 * need this header or CORS-mode fetches (fonts, Lottie JSON) fail.
 *
 * `*` is safe here because these protocols only serve local resources and none
 * of their responses depend on credentials. Copy the original headers so 304
 * and Range responses keep their metadata.
 */
export function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** GET 的 If-None-Match 使用弱比较，兼容通配符与多个候选版本。 */
export function matchesIfNoneMatch(value: string | null, etag: string): boolean {
  return (
    value?.split(',').some((tag) => {
      const candidate = tag.trim();
      return candidate === '*' || candidate.replace(/^W\//, '') === etag.replace(/^W\//, '');
    }) ?? false
  );
}
