import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { createHash } from 'node:crypto';
import { lockRemoteViewport } from './remote_viewport';
import { remoteStartupRecovery } from './startup_recovery';
import {
  parse,
  serialize,
  defaultTreeAdapter,
  html as htmlNames,
  type DefaultTreeAdapterMap,
} from 'parse5';

const compress = promisify(gzip);
// WebKit 内存缓存命中时 timing 尺寸可能全为零；在资源标签之前保存真实 load/error，供稍后接入的手机壳补读。
export const startupResourceTracker = String.raw`
(function () {
  var state = window.weqRemoteResourceLoads = Object.create(null);
  function record(event) {
    var target = event.target;
    if (!target || (target.tagName !== 'SCRIPT' && target.tagName !== 'LINK')) return;
    try {
      var url = new URL(target.src || target.href, location.href);
      if (url.origin !== location.origin || !/^\/assets\/[^/]+\.(js|css)$/.test(url.pathname)) return;
      state[url.pathname + url.search] = event.type === 'load';
      window.dispatchEvent(new Event('weq-remote-resource-load'));
    } catch (_) {}
  }
  function stop() {
    if (!window.weqRemoteStartup || window.weqRemoteStartup.state === 'loading') return;
    document.removeEventListener('load', record, true);
    document.removeEventListener('error', record, true);
    window.removeEventListener('weq-remote-startup', stop);
  }
  document.addEventListener('load', record, true);
  document.addEventListener('error', record, true);
  window.addEventListener('weq-remote-startup', stop);
})();`;
const tracker = startupResourceTracker + remoteStartupRecovery;
const trackerHash = `'sha256-${createHash('sha256').update(tracker).digest('base64')}'`;
type Asset = { path: string; raw: number; gzip: number; preload?: boolean };
function validAsset(value: unknown): value is Asset {
  if (!value || typeof value !== 'object') return false;
  const asset = value as Partial<Asset>;
  return (
    typeof asset.path === 'string' &&
    /^\/assets\/[^/?]+\.(?:js|css)$/.test(asset.path) &&
    Number.isSafeInteger(asset.raw) &&
    Number.isSafeInteger(asset.gzip) &&
    asset.raw! > 0 &&
    asset.gzip! > 0 &&
    typeof asset.preload === 'boolean'
  );
}

const offlinePath = /^\/assets\/[a-zA-Z0-9_.-]+\.(?:js|css|png|svg)$/;
type OfflineAsset = { path: string };

async function builtAssets(root: string, paths: Set<string>) {
  try {
    const data: { version?: unknown; entry?: unknown; resources?: unknown; offline?: unknown } =
      JSON.parse(await readFile(join(root, 'weq-startup.json'), 'utf8'));
    if (
      data.version !== 1 ||
      typeof data.entry !== 'string' ||
      !paths.has(data.entry) ||
      !Array.isArray(data.resources) ||
      !data.resources.length ||
      data.resources.length > 4096 ||
      !data.resources.every(validAsset)
    )
      return;
    const byPath = new Map(data.resources.map((asset) => [asset.path, asset]));
    // 构建清单必须匹配当前 HTML；旧产物、缺失清单继续走原有兼容路径。
    if (![...paths].every((path) => byPath.has(path))) return;
    const list = data.offline;
    const offline =
      Array.isArray(list) &&
      list.length <= 2048 &&
      list.every(
        (item: unknown): item is OfflineAsset =>
          !!item &&
          typeof item === 'object' &&
          'path' in item &&
          typeof item.path === 'string' &&
          offlinePath.test(item.path),
      ) &&
      [...byPath.keys()].every((path) => list.some((item: OfflineAsset) => item.path === path))
        ? list
        : undefined;
    return { assets: [...byPath.values()], offline };
  } catch {}
}
export function remoteReleaseDocument(body: string) {
  const version = createHash('sha256').update(body).digest('hex');
  return { body, version, etag: `"weq-release-${version}"` };
}

type RemoteReleaseDocument = ReturnType<typeof remoteReleaseDocument> & {
  completeOffline?: boolean;
};
type PreparedStartupShell = (gzip: boolean) => RemoteReleaseDocument;

// 同一构建的 HTML 最多保留原始与 gzip 清单两份，构建切换后重新准备。
let cached: { root: string; html: string; shell: Promise<PreparedStartupShell> } | undefined;

export async function startupShell(
  root: string,
  html: string,
  gzipAccepted: boolean,
): Promise<string> {
  return (await preparedStartupDocument(root, html, gzipAccepted)).body;
}

export async function preparedStartupDocument(
  root: string,
  html: string,
  gzipAccepted: boolean,
): Promise<RemoteReleaseDocument> {
  if (!cached || cached.root !== root || cached.html !== html) {
    const entry = { root, html, shell: prepareStartupShell(root, html) };
    cached = entry;
    void entry.shell.catch(() => {
      if (cached === entry) cached = undefined;
    });
  }
  return (await cached.shell)(gzipAccepted);
}

async function prepareStartupShell(root: string, html: string): Promise<PreparedStartupShell> {
  const document = parse(html);
  const paths = new Set<string>();
  let head: DefaultTreeAdapterMap['element'] | undefined;
  function visit(node: DefaultTreeAdapterMap['node']) {
    if ('tagName' in node) {
      if (node.tagName === 'head') head = node;
      const attr = (name: string) => node.attrs.find((a) => a.name === name)?.value;
      if (
        node.tagName === 'meta' &&
        attr('http-equiv')?.toLowerCase() === 'content-security-policy'
      ) {
        const content = node.attrs.find((a) => a.name === 'content');
        if (content) {
          const directives = content.value.split(';').map((part) => part.trim().split(/\s+/));
          const script = directives.find((parts) => parts[0] === 'script-src');
          if (script) script.push(trackerHash);
          else
            directives.push([
              'script-src',
              ...(directives.find((parts) => parts[0] === 'default-src')?.slice(1) ?? ["'self'"]),
              trackerHash,
            ]);
          directives.find((parts) => parts[0] === 'script-src-elem')?.push(trackerHash);
          content.value = directives.map((parts) => parts.join(' ')).join('; ');
        }
      }
      const rel = attr('rel')?.split(/\s+/) ?? [];
      const value =
        node.tagName === 'script'
          ? attr('src')
          : node.tagName === 'link' && rel.some((r) => r === 'stylesheet' || r === 'modulepreload')
            ? attr('href')
            : undefined;
      if (value) {
        const url = new URL(value, 'https://weq.invalid/');
        if (
          url.origin === 'https://weq.invalid' &&
          /^\/assets\/[^/]+\.(?:js|css)$/.test(url.pathname)
        )
          paths.add(url.pathname + url.search);
      }
    }
    if ('childNodes' in node) node.childNodes.forEach(visit);
  }
  visit(document);
  if (!head || paths.size === 0) {
    const unchanged = remoteReleaseDocument(html);
    return () => unchanged;
  }
  lockRemoteViewport(head);
  const inventory = await builtAssets(root, paths);
  const assets = inventory?.assets ?? [];
  if (!assets.length) {
    for (const path of paths) {
      const body = await readFile(join(root, new URL(path, 'https://weq.invalid').pathname));
      assets.push({
        path,
        raw: body.length,
        gzip: body.length >= 1024 ? (await compress(body)).length : body.length,
      });
    }
  }
  const content = { name: 'content', value: '' };
  const meta = defaultTreeAdapter.createElement('meta', htmlNames.NS.HTML, [
    { name: 'name', value: 'weq-startup-resources' },
    content,
  ]);
  const first = head.childNodes[0];
  if (first) defaultTreeAdapter.insertBefore(head, meta, first);
  else defaultTreeAdapter.appendChild(head, meta);
  if (assets.some((asset) => asset.preload)) {
    const offline = defaultTreeAdapter.createElement('meta', htmlNames.NS.HTML, [
      { name: 'name', value: 'weq-offline-bundle' },
      {
        name: 'content',
        value: JSON.stringify({
          version: 1,
          waitForWorkspace: true,
          resources: assets.map(({ path }) => ({ path })),
        }),
      },
    ]);
    defaultTreeAdapter.insertBefore(head, offline, meta);
  }
  if (inventory?.offline) {
    const complete = defaultTreeAdapter.createElement('meta', htmlNames.NS.HTML, [
      { name: 'name', value: 'weq-offline-code' },
      {
        name: 'content',
        value: JSON.stringify({ version: 1, waitForWorkspace: true, resources: inventory.offline }),
      },
    ]);
    defaultTreeAdapter.insertBefore(head, complete, meta);
  }
  const boot = defaultTreeAdapter.createElement('script', htmlNames.NS.HTML, []);
  defaultTreeAdapter.insertText(boot, tracker);
  const resource = head.childNodes.find(
    (node) => 'tagName' in node && (node.tagName === 'script' || node.tagName === 'link'),
  );
  if (resource) defaultTreeAdapter.insertBefore(head, boot, resource);
  else defaultTreeAdapter.appendChild(head, boot);
  const variants = new Map<boolean, RemoteReleaseDocument>();
  return (gzip) => {
    const existing = variants.get(gzip);
    if (existing !== undefined) return existing;
    const resources = assets
      .filter((asset) => !asset.preload)
      .map((asset) => ({
        path: asset.path,
        size: gzip ? asset.gzip : asset.raw,
      }));
    content.value = JSON.stringify({ version: 1, resources });
    const output = {
      ...remoteReleaseDocument(serialize(document)),
      completeOffline: !!inventory?.offline,
    };
    variants.set(gzip, output);
    return output;
  };
}
