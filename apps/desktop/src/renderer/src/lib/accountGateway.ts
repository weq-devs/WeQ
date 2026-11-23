const accountPrefix =
  typeof location === 'undefined'
    ? ''
    : (/^\/_weq\/account\/[^/]+\/[a-f\d-]{36}(?=\/|$)/i.exec(location.pathname)?.[0] ?? '');

export const isAccountGateway = !!accountPrefix;
const routeId = accountPrefix.split('/').at(-1);

export function accountGatewayPath(path: string): string {
  return accountPrefix + path;
}

export function accountGatewayUnscopedPath(path: string): string {
  return accountPrefix && path.startsWith(`${accountPrefix}/`)
    ? path.slice(accountPrefix.length)
    : path;
}

/** cid 不参与手机媒体缓存键，同一资源可在重新选账号后复用。 */
export function accountGatewayResource(source: string): string {
  if (!routeId || !/^\/_(?:media|asset|avatar)\//.test(source)) return source;
  const url = new URL(source, location.origin);
  const cid = url.searchParams.get('cid') ?? '';
  if (!cid.endsWith(`~${routeId}`)) url.searchParams.set('cid', `${cid}~${routeId}`);
  return `${url.pathname}${url.search}${url.hash}`;
}
