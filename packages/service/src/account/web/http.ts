/**
 * Thin `fetch` wrappers for QQ web cgis. They only add the cookie header, the
 * urlencoded content-type on POST, and turn a non-2xx / non-JSON response into a
 * clear error — everything cgi-specific (params, parsing) stays in the callers.
 */

export interface WebRequestInit {
  method?: 'GET' | 'POST';
  /** Full `Cookie` header value (see {@link cookieHeader}). */
  cookie: string;
  /** urlencoded form body; only sent on POST. */
  body?: string;
  /** Extra headers (e.g. Referer). */
  headers?: Record<string, string>;
}

/** GET/POST and return the raw response text. Throws on non-2xx. */
export async function webRequestText(url: string, init: WebRequestInit): Promise<string> {
  const method = init.method ?? 'GET';
  const res = await fetch(url, {
    method,
    headers: {
      Cookie: init.cookie,
      ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...init.headers,
    },
    body: method === 'POST' ? (init.body ?? '') : undefined,
  });
  if (!res.ok) {
    throw new Error(`web cgi ${res.status} ${res.statusText}: ${url}`);
  }
  return res.text();
}

/** GET/POST and parse the response as JSON. Throws on non-2xx or non-JSON. */
export async function webRequestJson<T>(url: string, init: WebRequestInit): Promise<T> {
  const text = await webRequestText(url, init);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`web cgi returned non-JSON (${url}): ${text.slice(0, 200)}`);
  }
}
