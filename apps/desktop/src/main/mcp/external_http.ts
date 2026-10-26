/** HTTP 和 SSE 共用来源约束；重定向需用户改填最终端点，不能携带密钥跟随。 */
export function externalMcpHttpOptions(url: URL, headers?: Record<string, string>) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('MCP 端点仅支持 HTTP/HTTPS');
  const origin = url.origin;
  const fetchWithoutRedirects: typeof fetch = (input, init) => {
    const target = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (target.origin !== origin)
      return Promise.reject(new Error('已阻止 MCP 跨来源请求，请配置最终端点 URL。'));
    return fetch(input, { ...init, redirect: 'error' });
  };
  return {
    requestInit: { headers, redirect: 'error' as const },
    fetch: fetchWithoutRedirects,
    eventSourceInit: { fetch: fetchWithoutRedirects },
    redirectPolicy: 'same-origin' as const,
  };
}
