import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse, parseFragment, serialize, type DefaultTreeAdapterMap } from 'parse5';
import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import { init, parse as imports } from 'es-module-lexer';
import { parse as parseJavaScript } from '@babel/parser';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import { parseSrcset, stringifySrcset } from 'srcset';
import { downloadUrlToFile } from '../media_url';
import { fileDigest } from './archive_resource';

export interface OfflineDependency {
  source: string;
  path?: string;
  sha256?: string;
  dependencies: string[];
  error?: string;
}
export interface OfflineArtifactManifest {
  complete: boolean;
  runtimeRequests: 'not-executed';
  resources: OfflineDependency[];
}
interface Reference {
  url: string;
  set(value: string): void;
}
interface Document {
  refs: Reference[];
  render(): string;
  dynamic: boolean;
  base?: string;
}
type HtmlNode = DefaultTreeAdapterMap['node'];

function cssDocument(text: string): Document {
  const tree = postcss.parse(text);
  const refs: Reference[] = [];
  tree.walkDecls((decl) => {
    const value = valueParser(decl.value);
    value.walk((node) => {
      if (node.type === 'function' && /^(?:-webkit-)?image-set$/i.test(node.value)) {
        for (const child of node.nodes)
          if (child.type === 'string')
            refs.push({
              url: child.value,
              set: (url) => {
                child.value = url;
                decl.value = value.toString();
              },
            });
      }
      if (node.type !== 'function' || node.value.toLowerCase() !== 'url') return;
      const child = node.nodes.find((part) => part.type === 'word' || part.type === 'string');
      if (child)
        refs.push({
          url: child.value,
          set: (url) => {
            child.value = url;
            decl.value = value.toString();
          },
        });
    });
  });
  tree.walkAtRules('import', (rule) => {
    const value = valueParser(rule.params);
    const first = value.nodes.find((node) => node.type !== 'space' && node.type !== 'comment');
    const target =
      first?.type === 'function'
        ? first.nodes.find((node) => node.type === 'string' || node.type === 'word')
        : first;
    if (target && (target.type === 'string' || target.type === 'word'))
      refs.push({
        url: target.value,
        set: (url) => {
          target.value = url;
          rule.params = value.toString();
        },
      });
  });
  return { refs, render: () => tree.toString(), dynamic: false };
}
async function jsDocument(text: string): Promise<Document> {
  await init;
  const [entries] = imports(text);
  const tree = parseJavaScript(text, { sourceType: 'unambiguous' });
  let runtime = false;
  const networkCalls = new Set([
    'fetch',
    'XMLHttpRequest',
    'WebSocket',
    'EventSource',
    'Worker',
    'SharedWorker',
    'importScripts',
    'sendBeacon',
  ]);
  function inspect(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const child of value) inspect(child);
      return;
    }
    const node = value as Record<string, unknown>;
    if (node.type === 'CallExpression' || node.type === 'NewExpression') {
      const callee = node.callee as Record<string, unknown> | undefined;
      const property = callee?.property as Record<string, unknown> | undefined;
      const name =
        callee?.type === 'Identifier' ? callee.name : (property?.name ?? property?.value);
      if (typeof name === 'string' && networkCalls.has(name)) runtime = true;
    }
    for (const [key, child] of Object.entries(node)) if (key !== 'loc') inspect(child);
  }
  inspect(tree);
  const edits: Array<{ start: number; end: number; value: string }> = [];
  const refs = entries
    .filter((entry) => entry.n && /^(?:[./]|https?:)/.test(entry.n))
    .map(
      (entry): Reference => ({
        url: entry.n!,
        set: (value) =>
          edits.push({
            start: entry.s,
            end: entry.e,
            value: entry.d < 0 ? value : JSON.stringify(value),
          }),
      }),
    );
  return {
    refs,
    dynamic:
      runtime ||
      entries.some(
        (entry) => (entry.d >= 0 && !entry.n) || (entry.n && !/^(?:[./]|https?:)/.test(entry.n)),
      ),
    render: () => {
      let result = text;
      for (const edit of edits.sort((a, b) => b.start - a.start))
        result = result.slice(0, edit.start) + edit.value + result.slice(edit.end);
      return result;
    },
  };
}
async function htmlDocument(text: string, fragment = false): Promise<Document> {
  const tree = fragment ? parseFragment(text) : parse(text);
  const refs: Reference[] = [];
  const embedded: Array<() => void> = [];
  let dynamic = false;
  let base: string | undefined;
  async function visit(node: HtmlNode): Promise<void> {
    if ('tagName' in node) {
      const attr = (name: string) => node.attrs.find((attribute) => attribute.name === name);
      const tag = node.tagName;
      for (const name of ['src', 'poster', 'data', 'href', 'xlink:href']) {
        const attribute = attr(name);
        const resource =
          name === 'src'
            ? [
                'img',
                'source',
                'audio',
                'video',
                'script',
                'embed',
                'input',
                'iframe',
                'track',
              ].includes(tag)
            : name === 'poster'
              ? tag === 'video'
              : name === 'data'
                ? tag === 'object'
                : tag === 'image' ||
                  tag === 'use' ||
                  (tag === 'link' &&
                    /(?:stylesheet|icon|preload|modulepreload)/.test(attr('rel')?.value ?? ''));
        if (attribute && resource)
          refs.push({
            url: attribute.value,
            set: (url) => {
              attribute.value = url;
              node.attrs = node.attrs.filter((item) => item.name !== 'integrity');
            },
          });
      }
      if (tag === 'base' && attr('href')) {
        base ??= attr('href')!.value;
        attr('href')!.value = './';
      }
      const srcset = attr('srcset');
      if (srcset && (tag === 'img' || tag === 'source')) {
        const candidates = parseSrcset(srcset.value, { strict: true }).map((candidate) => ({
          ...candidate,
        }));
        for (const candidate of candidates)
          refs.push({
            url: candidate.url,
            set: (url) => {
              candidate.url = url;
              srcset.value = stringifySrcset(candidates);
            },
          });
      }
      const style = attr('style');
      if (style) {
        const css = cssDocument(`x{${style.value}}`);
        refs.push(...css.refs);
        embedded.push(() => {
          style.value = css.render().slice(2, -1);
        });
      }
      if (
        (tag === 'style' ||
          (tag === 'script' &&
            !attr('src') &&
            (!attr('type') ||
              /^(?:module|(?:text|application)\/(?:java|ecma)script)$/i.test(
                attr('type')!.value,
              )))) &&
        'childNodes' in node
      ) {
        const textNode = node.childNodes.find((child) => child.nodeName === '#text');
        if (textNode && 'value' in textNode) {
          try {
            const doc =
              tag === 'style' ? cssDocument(textNode.value) : await jsDocument(textNode.value);
            refs.push(...doc.refs);
            dynamic ||= doc.dynamic;
            embedded.push(() => {
              textNode.value = doc.render();
            });
          } catch {
            dynamic = true;
          }
        }
      }
    }
    if ('childNodes' in node) for (const child of node.childNodes) await visit(child);
  }
  await visit(tree);
  return {
    refs,
    dynamic,
    base,
    render: () => {
      for (const apply of embedded) apply();
      return serialize(tree);
    },
  };
}
async function markdownDocument(text: string): Promise<Document> {
  const processor = unified().use(remarkParse).use(remarkStringify);
  const tree = processor.parse(text);
  const refs: Reference[] = [];
  const images = new Map<string, Node[]>();
  type Node = {
    type: string;
    url?: string;
    identifier?: string;
    value?: string;
    title?: string;
    referenceType?: string;
    label?: string;
    children?: Node[];
  };
  const root = tree as unknown as Node;
  const embedded: Array<() => void> = [];
  let dynamic = false;
  async function visit(node: Node, definitions = false): Promise<void> {
    if (!definitions && node.type === 'imageReference' && node.identifier) {
      const entries = images.get(node.identifier) ?? [];
      entries.push(node);
      images.set(node.identifier, entries);
    }
    if (
      ((!definitions && node.type === 'image') ||
        (definitions && node.type === 'definition' && images.has(node.identifier ?? ''))) &&
      node.url
    ) {
      const targets = definitions ? images.get(node.identifier ?? '')! : [node];
      for (const target of targets)
        refs.push({
          url: node.url,
          set: (url) => {
            target.type = 'image';
            target.url = url;
            if (definitions) target.title = node.title;
            delete target.identifier;
            delete target.referenceType;
            delete target.label;
          },
        });
    }
    if (!definitions && node.type === 'html' && node.value) {
      const doc = await htmlDocument(node.value, true);
      refs.push(...doc.refs);
      dynamic ||= doc.dynamic;
      embedded.push(() => {
        node.value = doc.render();
      });
    }
    for (const child of node.children ?? []) await visit(child, definitions);
  }
  await visit(root);
  await visit(root, true);
  return {
    refs,
    dynamic,
    render: () => {
      for (const apply of embedded) apply();
      return processor.stringify(tree);
    },
  };
}
function sourceLabel(url: string) {
  const parsed = new URL(url);
  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  return parsed.href;
}
function documentKind(url: string, type = '') {
  const ext = extname(new URL(url).pathname).toLowerCase();
  if (['.html', '.htm'].includes(ext)) return 'html';
  if (['.md', '.markdown'].includes(ext)) return 'markdown';
  if (ext === '.css' || type.includes('css')) return 'css';
  if (['.js', '.mjs', '.cjs'].includes(ext) || /(?:javascript|ecmascript)/.test(type)) return 'js';
  if (type.includes('html')) return 'html';
  return null;
}

/** 收集静态依赖图后再改写，循环引用无需等待彼此；失败项下次只补下载。 */
export async function localizeArtifact(options: {
  entry: string;
  sourcePath: string;
  outputEntry: string;
  cacheDirectory: string;
  signal: AbortSignal;
  download?: typeof downloadUrlToFile;
}): Promise<OfflineArtifactManifest> {
  const root = dirname(options.outputEntry);
  const sourceDirectory = dirname(resolve(options.sourcePath));
  const originalRoot = await realpath(sourceDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return sourceDirectory;
    throw error;
  });
  const initialUrl = pathToFileURL(options.sourcePath).href;
  const manifest: OfflineArtifactManifest = {
    complete: true,
    runtimeRequests: 'not-executed',
    resources: [],
  };
  type Resource = {
    url: string;
    file?: string;
    path?: string;
    doc?: Document;
    refs: Array<{ ref: Reference; key?: string; hash: string }>;
    report: OfflineDependency;
    base: string;
  };
  const nodes = new Map<string, Resource>();
  const binaryPaths = new Map<string, string>();
  const queue: Resource[] = [];
  function enqueue(url: string) {
    const existing = nodes.get(url);
    if (existing) return existing;
    const node: Resource = {
      url,
      refs: [],
      base: url,
      report: { source: sourceLabel(url), dependencies: [] },
    };
    nodes.set(url, node);
    queue.push(node);
    manifest.resources.push(node.report);
    return node;
  }
  enqueue(initialUrl);
  await mkdir(options.cacheDirectory, { recursive: true });
  const download = options.download ?? downloadUrlToFile;
  async function collect(node: Resource) {
    options.signal.throwIfAborted();
    try {
      let contentType = '';
      if (node.url === initialUrl) {
        node.file = options.entry;
        node.path = basename(options.outputEntry);
      } else {
        const key = createHash('sha256').update(node.url).digest('hex');
        node.file = join(options.cacheDirectory, key);
        try {
          const meta = JSON.parse(await readFile(`${node.file}.json`, 'utf8')) as {
            contentType: string;
            finalUrl: string;
            sha256: string;
          };
          if ((await fileDigest(node.file, options.signal)).sha256 !== meta.sha256)
            throw new Error('依赖缓存校验失败');
          contentType = meta.contentType;
          node.base = meta.finalUrl;
        } catch {
          options.signal.throwIfAborted();
          await rm(node.file, { force: true });
          await rm(`${node.file}.json`, { force: true });
          const url = new URL(node.url);
          if (url.protocol === 'file:') {
            const path = await realpath(fileURLToPath(url));
            if (path !== originalRoot && !path.startsWith(`${originalRoot}${sep}`))
              throw new Error('依赖位于成果来源目录之外');
            await copyFile(path, node.file);
          } else if (url.protocol === 'https:' || url.protocol === 'http:') {
            const outcome = await download(node.url, node.file, {
              signal: options.signal,
              allowText: true,
            });
            if (!outcome.ok) throw new Error('依赖下载失败');
            contentType = outcome.contentType;
            node.base = outcome.finalUrl || node.url;
          } else throw new Error('不支持的资源地址');
          await writeFile(
            `${node.file}.json`,
            JSON.stringify({
              contentType,
              finalUrl: node.base,
              sha256: (await fileDigest(node.file, options.signal)).sha256,
            }),
          );
        }
        const digest = await fileDigest(node.file, options.signal);
        const kind = documentKind(node.base, contentType);
        const suffix =
          extname(new URL(node.base).pathname).match(/^\.[\da-z]{1,8}$/i)?.[0] ??
          (kind ? `.${kind === 'markdown' ? 'md' : kind}` : '.bin');
        node.path = kind
          ? `assets/${key}${suffix}`
          : (binaryPaths.get(digest.sha256) ?? `assets/${digest.sha256}${suffix}`);
        if (!kind) binaryPaths.set(digest.sha256, node.path);
      }
      node.report.path = node.path;
      const kind = documentKind(node.base, contentType);
      if (kind) {
        const text = await readFile(node.file, 'utf8');
        node.doc =
          kind === 'html'
            ? await htmlDocument(text)
            : kind === 'markdown'
              ? await markdownDocument(text)
              : kind === 'css'
                ? cssDocument(text)
                : await jsDocument(text);
        if (node.doc.base) node.base = new URL(node.doc.base, node.base).href;
        if (node.doc.dynamic) {
          node.report.error = '包含未本地化的运行时依赖';
          manifest.complete = false;
        }
        for (const ref of node.doc.refs) {
          if (!ref.url || /^(?:#|data:)/i.test(ref.url)) continue;
          if (/^blob:/i.test(ref.url)) {
            node.report.error = '无法本地化临时 blob 资源';
            manifest.complete = false;
            continue;
          }
          try {
            const url = new URL(ref.url, node.base);
            const hash = url.hash;
            url.hash = '';
            const target = enqueue(url.href);
            node.refs.push({ ref, key: target.url, hash });
            node.report.dependencies.push(sourceLabel(target.url));
          } catch {
            node.report.error = '依赖地址无法解析';
            manifest.complete = false;
          }
        }
      }
    } catch (error) {
      options.signal.throwIfAborted();
      node.path = undefined;
      node.report.path = undefined;
      node.report.error = error instanceof Error ? error.message : '资源保存失败';
      manifest.complete = false;
    }
  }
  for (let cursor = 0; cursor < queue.length; ) {
    const batch = queue.slice(cursor, cursor + 4);
    cursor += batch.length;
    await Promise.all(batch.map(collect));
  }
  for (const node of queue) {
    options.signal.throwIfAborted();
    if (!node.path || !node.file) continue;
    const output = join(root, node.path);
    await mkdir(dirname(output), { recursive: true });
    for (const { ref, key, hash } of node.refs) {
      const target = key ? nodes.get(key) : undefined;
      if (target?.path) {
        const path = relative(dirname(output), join(root, target.path)).replaceAll('\\', '/');
        ref.set(`${path.startsWith('.') ? path : `./${path}`}${hash}`);
      }
    }
    if (node.doc) await writeFile(output, node.doc.render());
    else await copyFile(node.file, output);
    node.report.sha256 = (await fileDigest(output, options.signal)).sha256;
  }
  return manifest;
}
