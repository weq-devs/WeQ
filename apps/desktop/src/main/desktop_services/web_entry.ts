import { request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { setMaxListeners } from 'node:events';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import {
  LAST_REMOTE_ACCOUNT_KEY,
  REMOTE_ACCOUNT_ACCESS,
  REMOTE_ACCOUNT_ENTRY,
  REMOTE_WORKSPACE_KEY,
  type RemoteAccountChoice,
} from '../../shared/remote_account_switch';
import type { WebAuth } from '../web/application';
import { handleRequest } from '../web/http';
import { serveStatic } from '../web/static';
import { preparedStartupDocument } from '../web/startup_assets';
import { DevelopmentWebProxy } from '../web/development';
import { avatarResponse } from '../avatar_response';
import { toProtocolRequest, writeResponse } from '../web/protocol_adapter';
import { type DesktopAccountRoutes, PRIVATE_ACCOUNT_HEADER, type RoutedAccount } from './accounts';
import { PRIVATE_TOKEN_HEADER, PRIVATE_WEB_ROUTE_HEADER } from './control';

const ACCOUNT_PATH = /^\/_weq\/account\/([a-z\d][a-z\d_-]{0,127})\/([a-f\d-]{36})(\/.*)?$/i;
const ACCOUNT_SELECT = '/_weq/select-account';
const ACCOUNT_SWITCH = '/_weq/switch-account';
const ACCOUNT_AVATAR = '/_weq/account-avatar';
const LEAVE_ACCOUNT = '/_weq/leave-account';
const BUSINESS_PATH = /^\/(?:trpc(?:[/-]|$)|_[a-z][a-z0-9-]*(?:\/|\?|$))/;
const STATIC_PATH =
  /^\/(?:assets\/|src\/|node_modules\/|@[^/]+\/|favicon\.|robots\.txt|startup-theme\.js$|bundledDevClient\.mjs$)/;
const MAX_ACTIVE_ROUTES = 128;
const selectionStartup = `window.weqRemoteStartup = { state: 'action-required' };
window.dispatchEvent(new Event('weq-remote-startup'));`;
const selectionStartupHash = createHash('sha256').update(selectionStartup).digest('base64');
const QQ_UIN = /^[1-9]\d{0,19}$/;

const accountAccessStartup = `
const dialog = document.querySelector('#account-access');
const feedback = document.querySelector('#account-access-feedback');
const rows = document.querySelectorAll('[data-request-account]');
const endpoint = ${JSON.stringify(REMOTE_ACCOUNT_ACCESS)};
let configId;
for (const row of rows) row.addEventListener('click', () => {
  configId = row.dataset.requestAccount;
  dialog.querySelector('strong').textContent = row.querySelector('.account-name').textContent.trim();
  dialog.showModal();
});
dialog.addEventListener('close', async () => {
  if (dialog.returnValue !== 'request') return;
  dialog.returnValue = '';
  for (const row of rows) row.disabled = true;
  feedback.textContent = '正在发送申请…';
  try {
    let response = await fetch(endpoint, {method: 'POST', body: new URLSearchParams({configId}), redirect: 'error'});
    let result = await response.json();
    if (!response.ok) {
      feedback.textContent = result.error || '未能发送申请，请重试。';
      return;
    }
    if (result.state === 'pending') feedback.textContent = '已发送申请，请在电脑上的 WeQ 确认。';
    while (result.state === 'pending') {
      await new Promise(resolve => setTimeout(resolve, 2000));
      response = await fetch(endpoint + '?' + new URLSearchParams({id: result.id}), {redirect: 'error'});
      if (!response.ok) throw new Error();
      result = await response.json();
    }
    if (result.state === 'approved') {
      location.replace(location.pathname);
      return;
    }
    feedback.textContent = result.state === 'denied' ? '电脑拒绝了访问申请。' : '访问申请已失效，可重新申请。';
  } catch {
    feedback.textContent = '未能确认申请状态，请重试。';
  } finally {
    for (const row of rows) row.disabled = false;
  }
});`;
const accountAccessHash = createHash('sha256').update(accountAccessStartup).digest('base64');

// 在加载业务分包前，从同一手机网页来源恢复上次选中的账号。
const accountEntryStartup = String.raw`(function () {
  var last;
  try {
    last = localStorage.getItem(${JSON.stringify(LAST_REMOTE_ACCOUNT_KEY)});
    if (!last) {
      var workspace = JSON.parse(localStorage.getItem(${JSON.stringify(REMOTE_WORKSPACE_KEY)}) || 'null');
      if (workspace && typeof workspace.uin === 'string' && /^\d+$/.test(workspace.uin) &&
          typeof workspace.configId === 'string' && workspace.configId.length > 0 && workspace.configId.length <= 512 &&
          typeof workspace.static === 'boolean' && typeof workspace.mobile === 'boolean') last = workspace.configId;
    }
  } catch (_) {}
  var query = new URLSearchParams({ resume: '1' });
  if (last) query.set('last', last);
  window.weqRemoteStartup = { state: 'loading', message: '正在确认账号' };
  window.dispatchEvent(new Event('weq-remote-startup'));
  location.replace('/_weq/accounts?' + query);
})();`;
const accountEntryHash = createHash('sha256').update(accountEntryStartup).digest('base64');

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
}

function selectionPage(
  accounts: RemoteAccountChoice[],
  remote: boolean,
  error?: string,
  returnTo = '',
): string {
  const canRequest = accounts.some((account) => !account.authorized);
  // 手机网关外层使用 no-referrer；表单需要保留同源 Origin，不能发送 null。
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
${remote ? '<meta name="referrer" content="same-origin">' : ''}
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">
<title>WeQ · 打开账号</title><style>
body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:24px;color:CanvasText;background:Canvas}
main{max-width:32rem;margin:10vh auto}
header{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:1.125rem}
h1{font-size:1.75rem;margin:0}
button{display:flex;align-items:center;gap:12px;font:inherit;text-align:left;width:100%;margin-bottom:8px;padding:12px 16px;border:1px solid GrayText;border-radius:8px;color:CanvasText;background:Canvas;cursor:pointer}
button:hover{border-color:Highlight}small{display:block;color:GrayText}
button:disabled{opacity:.6;cursor:default}
#account-access-feedback:empty{display:none}
.cancel{display:grid;place-items:center;flex:none;width:44px;height:44px;border-radius:8px;color:CanvasText}
.cancel:hover{background:color-mix(in srgb,CanvasText 10%,Canvas)}
.avatar{position:relative;display:grid;place-items:center;flex:none;width:2.5rem;height:2.5rem;overflow:hidden;border-radius:50%;background:color-mix(in srgb,CanvasText 10%,Canvas);font-weight:600}
.avatar::after{content:'';position:absolute;inset:0;background:var(--avatar,none) center/cover no-repeat}
.account-name{flex:1;min-width:0;overflow-wrap:anywhere}
.status{flex:none;display:inline-flex;align-items:center;gap:6px}
.status::before{content:'';width:6px;height:6px;border-radius:50%;background:GrayText}
.status[data-online]::before{background:#21834c}
dialog{box-sizing:border-box;width:min(22rem,calc(100% - 32px));border:1px solid GrayText;border-radius:8px;color:CanvasText;background:Canvas;padding:20px;overflow-wrap:anywhere}
dialog::backdrop{background:rgb(0 0 0 / .36)}
dialog h2{margin:0;font-size:1.15rem}
dialog footer{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px}
dialog button{width:auto;margin:0}
dialog button[value=request]{background:Highlight;color:HighlightText}
@media(prefers-color-scheme:dark){.status[data-online]::before{background:#59c982}}
</style></head><body><main><header><h1>${returnTo ? '切换账号' : '打开 WeQ 账号'}</h1>
${
  returnTo
    ? `<a class="cancel" href="${returnTo}" aria-label="取消切换" title="取消切换">
<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
</a>`
    : ''
}
</header>
${error ? `<p role="alert">${escapeHtml(error)}</p>` : ''}
${canRequest ? '<p id="account-access-feedback" role="status"></p>' : ''}
${
  accounts.length
    ? accounts
        .map((item) => {
          const avatar = item.avatarUrl ? ` style="--avatar:url('${item.avatarUrl}')"` : '';
          const initial = [...item.displayName.trim()][0] ?? '?';
          const id = escapeHtml(item.configId);
          const button = item.authorized
            ? `<button type="submit" name="configId" value="${id}">`
            : `<button type="button" data-request-account="${id}">`;
          const status = !item.authorized
            ? '未授权'
            : item.online === null
              ? '状态未知'
              : item.online
                ? 'WeQ 在线'
                : 'WeQ 离线';
          return `${item.authorized ? `<form method="post" action="${returnTo.slice(0, -1)}${ACCOUNT_SELECT}">` : ''}
${button}
<span class="avatar" aria-hidden="true"${avatar}>${escapeHtml(initial)}</span>
<span class="account-name">${escapeHtml(item.displayName)} <small>${escapeHtml(item.uin)}${item.static ? ' · 静态备份' : ''}</small></span>
<small class="status"${item.online ? ' data-online' : ''}>${status}</small>
</button>${item.authorized ? '</form>' : ''}`;
        })
        .join('')
    : '<p>暂无可访问的账号。请在电脑上的 WeQ 检查账号及授权。</p>'
}
</main>${
    canRequest
      ? `<dialog id="account-access" aria-labelledby="account-access-title">
<form method="dialog"><h2 id="account-access-title">申请账号访问权限</h2>
<p>要向电脑申请访问 <strong></strong> 吗？</p>
<footer><button value="cancel">取消</button><button value="request" autofocus>发送申请</button></footer></form>
</dialog><script>${accountAccessStartup}</script>`
      : ''
  }${remote ? `<script>${selectionStartup}</script>` : ''}</body></html>`;
}

function visiblePath(req: IncomingMessage): URL {
  return new URL(req.url ?? '/', 'http://localhost');
}

function scopedRequest(req: IncomingMessage) {
  const url = visiblePath(req);
  const direct = ACCOUNT_PATH.exec(url.pathname);
  if (direct)
    return { configId: direct[1]!, routeId: direct[2]!, path: (direct[3] ?? '/') + url.search };
  if (/^\/_(?:media|asset|avatar)\//.test(url.pathname)) {
    const tag = /^(.*?)~([a-f\d-]{36})$/i.exec(url.searchParams.get('cid') ?? '');
    if (tag) {
      if (tag[1]) url.searchParams.set('cid', tag[1]);
      else url.searchParams.delete('cid');
      return { configId: undefined, routeId: tag[2]!, path: url.pathname + url.search };
    }
  }
  if (!BUSINESS_PATH.test(url.pathname) || !req.headers.referer) return null;
  try {
    const referrer = new URL(req.headers.referer);
    if (referrer.host !== req.headers.host) return null;
    const route = ACCOUNT_PATH.exec(referrer.pathname);
    if (route) return { configId: route[1]!, routeId: route[2]!, path: url.pathname + url.search };
  } catch {
    return null;
  }
  return null;
}

function proxyRequest(
  req: IncomingMessage,
  path: string,
  route: RoutedAccount,
  remote: boolean,
  routeId: string,
) {
  const endpoint = remote ? route.remote : route.browser;
  const headers = { ...req.headers };
  delete headers.cookie;
  delete headers.authorization;
  delete headers['proxy-authorization'];
  delete headers['x-forwarded-for'];
  headers[PRIVATE_TOKEN_HEADER] = endpoint.token;
  headers[PRIVATE_ACCOUNT_HEADER] = route.account.generation;
  headers[PRIVATE_WEB_ROUTE_HEADER] = `/_weq/account/${route.account.configId}/${routeId}`;
  return request({
    hostname: '127.0.0.1',
    port: endpoint.port,
    method: req.method,
    path,
    headers,
  });
}

function respondError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) res.destroy();
  else
    res
      .writeHead(status, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      .end(message);
}

function respondSelectionJson(res: ServerResponse, status: number, body: object): void {
  res
    .writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      Vary: 'Accept',
    })
    .end(JSON.stringify(body));
}

function requireRemoteSelection(res: ServerResponse): void {
  res.writeHead(409, { 'X-WeQ-Account-Selection': 'required', 'Cache-Control': 'no-store' }).end();
}

function validSelectionOrigin(req: IncomingMessage, auth: WebAuth): boolean {
  const { host, origin, authorization } = req.headers;
  // 手机本机网关使用已验证的设备 Bearer 凭据转发，不保留浏览器的 Origin。
  return Boolean(
    host &&
      (origin === `http://${host}` ||
        origin === `https://${host}` ||
        (!origin && auth.remoteClient && /^Bearer [a-f\d]{64}$/i.test(authorization ?? ''))),
  );
}

async function selectedAccount(req: IncomingMessage): Promise<string> {
  if (!req.headers['content-type']?.startsWith('application/x-www-form-urlencoded'))
    throw new Error('账号选择请求无效。');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    bytes += chunk.length;
    if (bytes > 4096) throw new Error('账号选择请求过大。');
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8')).get('configId') ?? '';
}

export class DesktopWebEntry {
  readonly webAccountEntry = true;
  private readonly paths = new Map<
    string,
    {
      account: RoutedAccount;
      owner: string | null | undefined;
      controller: AbortController;
      stopWatching?: () => void;
    }
  >();
  private readonly connections = new Set<Duplex>();
  private readonly development?: DevelopmentWebProxy;
  private detach?: () => void;
  private release?: Promise<string | undefined>;

  constructor(
    private readonly options: {
      auth: WebAuth;
      publicDir: string;
      developmentUrl?: string;
      accounts: DesktopAccountRoutes;
      loadAccountAvatar: (uin: string) => Promise<{ data: Uint8Array; contentType: string } | null>;
    },
  ) {
    if (options.developmentUrl)
      this.development = new DevelopmentWebProxy(options.developmentUrl, options.auth);
  }

  private allowed(req: IncomingMessage, configId: string): boolean {
    const grant = this.options.auth.accountIds?.(req);
    return grant === undefined || grant.includes(configId);
  }

  private route(req: IncomingMessage, scope = scopedRequest(req)) {
    if (!scope) return null;
    const active = this.paths.get(scope.routeId);
    const configId = active?.account.account.configId;
    if (
      !active ||
      active.owner !== this.options.auth.identityKey?.(req) ||
      !configId ||
      (scope.configId !== undefined && configId !== scope.configId) ||
      !this.allowed(req, configId)
    )
      return null;
    return {
      scope: { ...scope, configId },
      account: active.account,
      signal: active.controller.signal,
    };
  }

  private removePath(id: string): void {
    const active = this.paths.get(id);
    this.paths.delete(id);
    active?.stopWatching?.();
    active?.controller.abort();
  }

  private availableAccounts(req: IncomingMessage) {
    return this.options.accounts.list().filter((account) => this.allowed(req, account.configId));
  }

  private async showAccounts(
    req: IncomingMessage,
    res: ServerResponse,
    error?: string,
    returnTo?: string,
  ) {
    const { auth, accounts } = this.options;
    const remote = !!auth.remoteClient;
    const json = remote && returnTo && req.headers.accept === 'application/json';
    const saved = accounts.list();
    const windows = saved.length ? await accounts.windows().catch(() => null) : [];
    if (res.destroyed) return;
    if (!auth.isAuthed(req)) return respondError(res, 401, '账号授权已变化。');
    if (json && error) return respondSelectionJson(res, 409, { error });
    const online =
      windows && new Set(windows.flatMap((w) => (w.account ? w.account.configId : [])));
    const choices: RemoteAccountChoice[] = saved.flatMap((item) => {
      const { configId, displayName, uin, static: isStatic } = item;
      const authorized = this.allowed(req, configId);
      if (!authorized && !auth.accountAccess) return [];
      return [
        {
          configId,
          displayName,
          uin,
          static: isStatic,
          authorized,
          online: authorized ? (online?.has(configId) ?? null) : null,
          avatarUrl:
            authorized && QQ_UIN.test(uin)
              ? `${ACCOUNT_AVATAR}?${new URLSearchParams({ configId })}`
              : null,
        },
      ];
    });
    if (remote) {
      const rank = (item: RemoteAccountChoice) => (!item.authorized ? 2 : item.online ? 0 : 1);
      choices.sort((a, b) => rank(a) - rank(b));
    }
    if (json) {
      return respondSelectionJson(res, 200, choices);
    }
    // 手机 WebView 不展示 4xx 主文档；可继续选择的错误页仍走启动回执。
    res
      .writeHead(error && !remote ? 409 : 200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        ...(returnTo ? { Vary: 'Accept' } : {}),
        'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'${remote ? `; connect-src 'self'; script-src 'sha256-${selectionStartupHash}' 'sha256-${accountAccessHash}'` : ''}`,
      })
      .end(selectionPage(choices, remote, error, returnTo));
  }

  private async accountAccess(req: IncomingMessage, res: ServerResponse, url: URL) {
    const { auth, accounts } = this.options;
    const access = auth.accountAccess;
    if (!access) return respondError(res, 404, '账号访问申请不可用。');
    if (req.method === 'GET')
      return respondSelectionJson(res, 200, access.poll(req, url.searchParams.get('id') ?? ''));
    if (req.method !== 'POST') return respondError(res, 405, '不支持的请求方式。');
    if (!validSelectionOrigin(req, auth))
      return respondSelectionJson(res, 403, { error: '账号访问申请需由当前页面发起。' });
    try {
      const configId = await selectedAccount(req);
      if (res.destroyed) return;
      if (!auth.isAuthed(req)) return respondError(res, 401, '账号授权已变化。');
      const account = accounts.list().find((item) => item.configId === configId);
      if (!account) return respondSelectionJson(res, 404, { error: '账号已不存在。' });
      const { displayName, uin, static: isStatic } = account;
      return respondSelectionJson(
        res,
        200,
        access.request(req, { configId, displayName, uin, static: isStatic }),
      );
    } catch (error) {
      return respondSelectionJson(res, 409, {
        error: error instanceof Error ? error.message : '账号访问申请未能发送。',
      });
    }
  }

  private async showAccountAvatar(req: IncomingMessage, res: ServerResponse, configId: string) {
    const { auth, accounts, loadAccountAvatar } = this.options;
    const account = this.allowed(req, configId)
      ? accounts.list().find((item) => item.configId === configId)
      : undefined;
    if (!account || !QQ_UIN.test(account.uin)) return respondError(res, 404, '头像不可用。');
    const avatar = await loadAccountAvatar(account.uin);
    if (res.destroyed) return;
    if (!auth.isAuthed(req) || !this.allowed(req, configId))
      return respondError(res, 401, '账号授权已变化。');
    if (!avatar?.data.length) return respondError(res, 404, '头像不可用。');
    const request = toProtocolRequest(req, 'weq-avatar', '/_weq');
    const response = avatarResponse(avatar, request ?? undefined);
    response.headers.set('Cache-Control', 'private, no-cache');
    return writeResponse(res, response);
  }

  private async openSelected(
    req: IncomingMessage,
    res: ServerResponse,
    configId: string,
    returnTo?: string,
  ) {
    try {
      if (!this.allowed(req, configId)) throw new Error('此账号未授权。');
      const selected = await this.options.accounts.open(configId);
      return this.enterAccount(
        req,
        res,
        selected,
        !!returnTo && req.headers.accept === 'application/json',
      );
    } catch (error) {
      return this.showAccounts(
        req,
        res,
        error instanceof Error ? error.message : '账号打开失败。',
        returnTo,
      );
    }
  }

  private enterAccount(
    req: IncomingMessage,
    res: ServerResponse,
    selected: RoutedAccount,
    json = false,
  ) {
    const { auth } = this.options;
    const { configId } = selected.account;
    if (res.destroyed) return;
    if (!auth.isAuthed(req) || !this.allowed(req, configId))
      return respondError(res, 401, '账号授权已变化。');
    const id = randomUUID();
    const controller = new AbortController();
    setMaxListeners(0, controller.signal);
    const route = {
      account: selected,
      owner: auth.identityKey?.(req),
      controller,
      stopWatching: undefined as (() => void) | undefined,
    };
    this.paths.set(id, route);
    route.stopWatching = auth.watchSession(req, () => this.removePath(id));
    if (controller.signal.aborted) {
      route.stopWatching();
      return respondError(res, 401, '账号授权已变化。');
    }
    if (this.paths.size > MAX_ACTIVE_ROUTES) this.removePath(this.paths.keys().next().value!);
    const location = `/_weq/account/${encodeURIComponent(configId)}/${id}/`;
    if (json) return respondSelectionJson(res, 200, { location });
    res.writeHead(303, { Location: location, 'Cache-Control': 'no-store' }).end();
  }

  private async selectFromForm(req: IncomingMessage, res: ServerResponse, returnTo?: string) {
    if (!validSelectionOrigin(req, this.options.auth))
      return respondError(res, 403, '账号选择需由当前页面发起。');
    let configId: string;
    try {
      configId = await selectedAccount(req);
    } catch (error) {
      return this.showAccounts(
        req,
        res,
        error instanceof Error ? error.message : '账号打开失败。',
        returnTo,
      );
    }
    return this.openSelected(req, res, configId, returnTo);
  }

  handle(req: IncomingMessage, res: ServerResponse): void {
    void this.process(req, res).catch(() => respondError(res, 503, '账号服务暂不可用。'));
  }

  private async process(req: IncomingMessage, res: ServerResponse) {
    const { auth, publicDir, accounts } = this.options;
    const url = visiblePath(req);
    const { pathname } = url;
    res.setHeader('Referrer-Policy', 'same-origin');
    if (pathname.startsWith('/_auth/') || !auth.isAuthed(req)) {
      await handleRequest(req, res, {
        auth,
        publicDir,
        trpc: (_req, reply) => respondError(reply, 401, '请先登录。'),
      });
      return;
    }
    if (pathname === REMOTE_ACCOUNT_ACCESS) return this.accountAccess(req, res, url);
    if (pathname === ACCOUNT_SELECT && req.method === 'POST') return this.selectFromForm(req, res);
    if (pathname === ACCOUNT_AVATAR && req.method === 'GET')
      return this.showAccountAvatar(req, res, url.searchParams.get('configId') ?? '');
    if (pathname === REMOTE_ACCOUNT_ENTRY && req.method === 'GET' && auth.remoteClient) {
      res
        .writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': `default-src 'none'; script-src 'sha256-${accountEntryHash}'; frame-ancestors 'none'`,
        })
        .end(
          `<!doctype html><meta charset="utf-8"><title>WeQ</title><script>${accountEntryStartup}</script>`,
        );
      return;
    }
    if (STATIC_PATH.test(pathname) && (req.method === 'GET' || req.method === 'HEAD')) {
      if (this.development) await this.development.handle(req, res);
      else await serveStatic(res, publicDir, pathname, req.headers['accept-encoding']);
      return;
    }
    if (pathname === '/' && req.method === 'GET' && auth.remoteClient) {
      if (this.development) await this.development.handle(req, res);
      else
        await serveStatic(
          res,
          publicDir,
          '/',
          req.headers['accept-encoding'],
          true,
          req.headers['if-none-match'] ?? null,
        );
      return;
    }
    if (pathname === '/' || pathname === '/_weq/accounts') {
      if (
        pathname === '/_weq/accounts' &&
        url.searchParams.get('resume') === '1' &&
        req.method === 'GET' &&
        auth.remoteClient
      ) {
        const allowed = this.availableAccounts(req);
        const preferred = url.searchParams.get('last');
        if (preferred) {
          if (allowed.some((account) => account.configId === preferred)) {
            const active = await accounts.find(preferred).catch(() => undefined);
            if (active) return this.enterAccount(req, res, active);
          }
        } else if (allowed.length === 1) {
          return this.openSelected(req, res, allowed[0]!.configId);
        }
      }
      return this.showAccounts(req, res);
    }
    const scope = scopedRequest(req);
    const routed = this.route(req, scope);
    const remoteAccountRead =
      auth.remoteClient &&
      req.method === 'GET' &&
      (/^\/trpc\/startup\.snapshot(?:,|$)/.test(pathname) || scope?.path.startsWith('/trpc/'));
    if (!routed) {
      // 服务重启会丢弃旧页面的账号路由；由当前页面重新选择，不重投旧请求。
      if (remoteAccountRead) return requireRemoteSelection(res);
      if ((req.headers.accept ?? '').includes('text/html')) {
        res.writeHead(303, { Location: '/', 'Cache-Control': 'no-store' }).end();
        return;
      }
      return respondError(res, 409, '账号已关闭，请重新选择账号。');
    }
    if (!auth.isAuthed(req) || !this.allowed(req, routed.scope.configId))
      return respondError(res, 401, '账号授权已变化。');
    if (auth.remoteClient) {
      const returnTo = `/_weq/account/${routed.scope.configId}/${routed.scope.routeId}/`;
      if (routed.scope.path === ACCOUNT_SWITCH) {
        if (req.method === 'HEAD')
          return res
            .writeHead(
              (auth.accountAccess ? accounts.list() : this.availableAccounts(req)).length > 1
                ? 204
                : 404,
              {
                'Cache-Control': 'no-store',
              },
            )
            .end();
        if (req.method === 'GET') return this.showAccounts(req, res, undefined, returnTo);
      }
      if (routed.scope.path === ACCOUNT_SELECT && req.method === 'POST')
        return this.selectFromForm(req, res, returnTo);
    }
    if (req.method === 'POST' && routed.scope.path === LEAVE_ACCOUNT) {
      if (!validSelectionOrigin(req, auth))
        return respondError(res, 403, '账号退出需由当前页面发起。');
      this.removePath(routed.scope.routeId);
      res.writeHead(204).end();
      return;
    }
    const upstream = proxyRequest(
      req,
      routed.scope.path,
      routed.account,
      !!auth.remoteClient,
      routed.scope.routeId,
    );
    const abort = () => {
      upstream.destroy();
      res.destroy();
    };
    const unwatch = auth.watchSession(req, abort);
    routed.signal.addEventListener('abort', abort, { once: true });
    upstream.once('error', (error: NodeJS.ErrnoException) => {
      if (res.destroyed) return;
      if (remoteAccountRead && !res.headersSent && error.code === 'ECONNREFUSED') {
        requireRemoteSelection(res);
        return;
      }
      respondError(res, 502, '账号窗口连接已关闭。');
    });
    upstream.once('response', (response) => {
      // 账号进程先用空 401 拒绝过期的 generation；业务鉴权错误带有正文类型。
      if (remoteAccountRead && response.statusCode === 401 && !response.headers['content-type']) {
        response.resume();
        requireRemoteSelection(res);
        return;
      }
      if (response.statusCode === 401 && (req.headers.accept ?? '').includes('text/html')) {
        response.resume();
        res.writeHead(303, { Location: '/', 'Cache-Control': 'no-store' }).end();
        return;
      }
      const headers = { ...response.headers };
      delete headers['set-cookie'];
      delete headers['referrer-policy'];
      res.writeHead(response.statusCode ?? 502, headers);
      response.pipe(res);
      res.once('close', () => response.destroy());
    });
    res.once('close', () => {
      unwatch();
      routed.signal.removeEventListener('abort', abort);
      upstream.destroy();
    });
    req.pipe(upstream);
  }

  attach(server: Server): void {
    const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      void this.upgrade(req, socket, head).catch(() => socket.destroy());
    };
    server.on('upgrade', upgrade);
    this.detach = () => server.off('upgrade', upgrade);
  }

  private async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const { auth } = this.options;
    if (!auth.isAuthed(req)) {
      socket.destroy();
      return;
    }
    if (this.development?.upgrade(req, socket, head)) return;
    const routed = this.route(req);
    if (!routed || !auth.isAuthed(req) || !this.allowed(req, routed.scope.configId)) {
      socket.destroy();
      return;
    }
    const proxy = proxyRequest(
      req,
      routed.scope.path,
      routed.account,
      !!auth.remoteClient,
      routed.scope.routeId,
    );
    this.connections.add(socket);
    const abort = () => socket.destroy();
    const stop = auth.watchSession(req, abort);
    routed.signal.addEventListener('abort', abort, { once: true });
    socket.once('close', () => {
      stop();
      routed.signal.removeEventListener('abort', abort);
      this.connections.delete(socket);
      proxy.destroy();
    });
    proxy.once('error', () => socket.destroy());
    proxy.once('response', () => socket.destroy());
    proxy.once('upgrade', (res, upstream, data) => {
      const headers = res.rawHeaders;
      let raw = `HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n`;
      for (let index = 0; index < headers.length; index += 2)
        raw += `${headers[index]}: ${headers[index + 1]}\r\n`;
      socket.write(`${raw}\r\n`);
      if (data.length) socket.write(data);
      if (head.length) upstream.write(head);
      upstream.once('error', () => socket.destroy());
      upstream.once('close', () => socket.destroy());
      socket.once('close', () => upstream.destroy());
      upstream.pipe(socket).pipe(upstream);
    });
    proxy.end();
  }

  stableWebRelease(): Promise<string | undefined> | undefined {
    const { publicDir } = this.options;
    if (this.development || !existsSync(join(publicDir, 'index.html'))) return;
    this.release ??= readFile(join(publicDir, 'index.html'), 'utf8')
      .then((source) => preparedStartupDocument(publicDir, source, false))
      .then((result) => (result.completeOffline ? result.version : undefined))
      .catch(() => undefined);
    return this.release;
  }

  close(): void {
    this.detach?.();
    this.development?.close();
    for (const socket of this.connections) socket.destroy();
    this.connections.clear();
    for (const id of this.paths.keys()) this.removePath(id);
  }
}
