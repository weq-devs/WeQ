import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  parse,
  serialize,
  defaultTreeAdapter,
  html as htmlNames,
  type DefaultTreeAdapterMap,
} from 'parse5';

const compress = promisify(gzip);
// WebKit 内存缓存命中时 timing 尺寸可能全为零；在资源标签之前保存真实 load/error，供稍后接入的手机壳补读。
const tracker = String.raw`
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
const trackerHash = `'sha256-${createHash('sha256').update(tracker).digest('base64')}'`;
type Asset = { path: string; raw: number; gzip: number };
// 只保留当前构建的清单与尺寸，不缓存整套资源，也不在每次手机连接时重新压缩。
let cached: { root: string; html: string; assets: Promise<Asset[]> } | undefined;

export async function startupShell(
  root: string,
  html: string,
  gzipAccepted: boolean,
): Promise<string> {
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
  if (!head || paths.size === 0) return html;
  if (!cached || cached.root !== root || cached.html !== html) {
    const assets = (async () => {
      const result: Asset[] = [];
      for (const path of paths) {
        const body = await readFile(join(root, new URL(path, 'https://weq.invalid').pathname));
        result.push({
          path,
          raw: body.length,
          gzip: body.length >= 1024 ? (await compress(body)).length : body.length,
        });
      }
      return result;
    })();
    const entry = { root, html, assets };
    cached = entry;
    void assets.catch(() => {
      if (cached === entry) cached = undefined;
    });
  }
  const resources = (await cached.assets).map((a) => ({
    path: a.path,
    size: gzipAccepted ? a.gzip : a.raw,
  }));
  const meta = defaultTreeAdapter.createElement('meta', htmlNames.NS.HTML, [
    { name: 'name', value: 'weq-startup-resources' },
    { name: 'content', value: JSON.stringify({ version: 1, resources }) },
  ]);
  const first = head.childNodes[0];
  if (first) defaultTreeAdapter.insertBefore(head, meta, first);
  else defaultTreeAdapter.appendChild(head, meta);
  const boot = defaultTreeAdapter.createElement('script', htmlNames.NS.HTML, []);
  defaultTreeAdapter.insertText(boot, tracker);
  const resource = head.childNodes.find(
    (node) => 'tagName' in node && (node.tagName === 'script' || node.tagName === 'link'),
  );
  if (resource) defaultTreeAdapter.insertBefore(head, boot, resource);
  else defaultTreeAdapter.appendChild(head, boot);
  return serialize(document);
}
