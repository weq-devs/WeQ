import { isRemoteClient } from './remoteClient';
import { LAST_REMOTE_ACCOUNT_KEY } from '../../../shared/remote_account_switch';

const accountPrefix =
  typeof location === 'undefined'
    ? ''
    : (/^\/_weq\/account\/[^/]+\/[a-f\d-]{36}(?=\/|$)/i.exec(location.pathname)?.[0] ?? '');

export const isAccountGateway = !!accountPrefix;
export const accountGatewayConfigId = accountPrefix.split('/')[3];
const routeId = accountPrefix.split('/').at(-1);
let cachedRemoteAccount: string | undefined;
let selectingAccount = false;

export function setCachedRemoteAccount(configId: string | undefined) {
  cachedRemoteAccount = configId;
}

export function rememberRemoteAccount(configId: string | undefined) {
  if (!isRemoteClient() || location.hostname !== '127.0.0.1') return;
  try {
    if (configId) localStorage.setItem(LAST_REMOTE_ACCOUNT_KEY, configId);
    else localStorage.removeItem(LAST_REMOTE_ACCOUNT_KEY);
  } catch {}
}

export function remoteAccountSelectionPending() {
  return selectingAccount;
}

export function resumeRemoteAccount() {
  if (selectingAccount) return;
  selectingAccount = true;
  let configId = cachedRemoteAccount;
  try {
    configId = localStorage.getItem(LAST_REMOTE_ACCOUNT_KEY) || configId;
  } catch {}
  const search = new URLSearchParams({ resume: '1' });
  if (configId) search.set('last', configId);
  location.replace(`/_weq/accounts?${search}`);
}

export function accountGatewayPath(path: string): string {
  return accountPrefix + path;
}

export const WEB_TRPC_PATH = accountGatewayPath('/trpc');

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
