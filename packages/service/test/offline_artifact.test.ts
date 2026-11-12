import { mkdtemp, mkdir, writeFile, readFile, rm, cp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { localizeArtifact } from '../src/account/export/offline_artifact';
import type { downloadUrlToFile } from '../src/account/media_url';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(text: string, suffix = 'html') {
  const root = await mkdtemp(join(tmpdir(), 'weq-offline-'));
  roots.push(root);
  const source = join(root, `source/index.${suffix}`);
  await mkdir(join(root, 'source'), { recursive: true });
  await writeFile(source, text);
  const files = new Map<string, { text: string; type: string }>();
  const download: typeof downloadUrlToFile = vi.fn(async (url, path) => {
    const file = files.get(url);
    if (!file) return { ok: false as const, reason: 'missing' };
    await writeFile(path, file.text);
    return {
      ok: true as const,
      bytes: Buffer.byteLength(file.text),
      contentType: file.type,
      sha256: '',
      finalUrl: url,
    };
  });
  const run = () =>
    localizeArtifact({
      entry: source,
      sourcePath: source,
      outputEntry: join(root, `output/index.${suffix}`),
      cacheDirectory: join(root, 'cache'),
      signal: new AbortController().signal,
      download,
    });
  return { root, source, files, download, run };
}
it('本地化 HTML、srcset、CSS 字体与循环模块，不改变原件，移机后仍只引用包内资源', async () => {
  const text =
    '<link rel="stylesheet" href="https://assets.test/main.css"><img src="https://assets.test/a.png" srcset="https://assets.test/a.png 1x, https://assets.test/b.png 2x"><script type="module" src="https://assets.test/a.js"></script><a href="https://other.test">链接</a>';
  const f = await fixture(text);
  f.files.set('https://assets.test/main.css', {
    text: '@import "extra.css";x{background:url(a.png)}',
    type: 'text/css',
  });
  f.files.set('https://assets.test/extra.css', {
    text: '@font-face{src:url(font.woff2)}',
    type: 'text/css',
  });
  for (const name of ['a.png', 'b.png', 'font.woff2'])
    f.files.set(`https://assets.test/${name}`, {
      text: 'same-bytes',
      type: 'application/octet-stream',
    });
  f.files.set('https://assets.test/a.js', {
    text: 'import "./b.js"; export const a=1;',
    type: 'text/javascript',
  });
  f.files.set('https://assets.test/b.js', {
    text: 'import "./a.js"; export const b=2;',
    type: 'text/javascript',
  });
  const manifest = await f.run();
  expect(manifest.complete).toBe(true);
  expect(manifest.resources).toHaveLength(8);
  expect(await readFile(f.source, 'utf8')).toBe(text);
  const output = await readFile(join(f.root, 'output/index.html'), 'utf8');
  expect(output).not.toContain('https://assets.test');
  expect(output).toContain('href="https://other.test"');
  await cp(join(f.root, 'output'), join(f.root, 'moved'), { recursive: true });
  await rm(join(f.root, 'source'), { recursive: true });
  for (const resource of manifest.resources) {
    expect(await readFile(join(f.root, 'moved', resource.path!))).not.toHaveLength(0);
    expect(resource.sha256).toMatch(/^[a-f\d]{64}$/);
  }
  const allAssets = await readdir(join(f.root, 'moved/assets'));
  expect(allAssets.length).toBeLessThan(manifest.resources.length - 1);
  const binary = manifest.resources.filter((resource) =>
    /(?:\.png|\.woff2)$/.test(resource.source),
  );
  expect(new Set(binary.map((resource) => resource.path)).size).toBe(1);
});
it('同名不同内容使用不同包内路径，不按 URL 文件名覆盖', async () => {
  const f = await fixture(
    '<img src="https://assets.test/one/photo.png"><img src="https://assets.test/two/photo.png">',
  );
  f.files.set('https://assets.test/one/photo.png', { text: 'one', type: 'image/png' });
  f.files.set('https://assets.test/two/photo.png', { text: 'two', type: 'image/png' });
  const result = await f.run();
  const resources = result.resources.filter((resource) => resource.source.endsWith('.png'));
  expect(result.complete).toBe(true);
  expect(resources[0]?.path).not.toBe(resources[1]?.path);
  for (const resource of resources)
    expect(await readFile(join(f.root, 'output', resource.path!), 'utf8')).toBe(
      resource.source.includes('/one/') ? 'one' : 'two',
    );
});
it('失败保留其他资源，重试只请求缺项，Markdown 普通超链接不下载', async () => {
  const f = await fixture(
    '![a](https://assets.test/a.png)\n![b][b]\n\n[b]: https://assets.test/b.png\n\n[链接](https://other.test)',
    'md',
  );
  f.files.set('https://assets.test/a.png', { text: 'a', type: 'image/png' });
  expect((await f.run()).complete).toBe(false);
  const calls = vi.mocked(f.download).mock.calls.length;
  f.files.set('https://assets.test/b.png', { text: 'b', type: 'image/png' });
  expect((await f.run()).complete).toBe(true);
  expect(
    vi
      .mocked(f.download)
      .mock.calls.slice(calls)
      .map((call) => call[0]),
  ).toEqual(['https://assets.test/b.png']);
  expect(await readFile(join(f.root, 'output/index.md'), 'utf8')).toContain('https://other.test');
});
it('记录无法静态确定的动态模块，不执行脚本；取消停止下载', async () => {
  const f = await fixture('<script type="module">import(variable)</script>');
  expect((await f.run()).resources[0]?.error).toContain('运行时');
  expect(f.download).not.toHaveBeenCalled();
  const signal = AbortSignal.abort();
  await expect(
    localizeArtifact({
      entry: f.source,
      sourcePath: f.source,
      outputEntry: join(f.root, 'cancel/index.html'),
      cacheDirectory: join(f.root, 'cache'),
      signal,
    }),
  ).rejects.toThrow();
});
it('运行时网络调用明确标记未本地化，不因脚本已保存而声称离线完整', async () => {
  for (const script of [
    'fetch("/api")',
    'new XMLHttpRequest()',
    'navigator.sendBeacon("/log", "x")',
  ]) {
    const f = await fixture(`<script>${script}</script>`);
    const result = await f.run();
    expect(result.complete).toBe(false);
    expect(result.resources[0]?.error).toContain('运行时');
    expect(f.download).not.toHaveBeenCalled();
  }
});
it('Markdown 图片和普通链接共用定义时只改写图片，临时 blob 不声称可离线', async () => {
  const f = await fixture(
    '![图片][shared]\n\n[普通链接][shared]\n\n[shared]: https://assets.test/image.png',
    'md',
  );
  f.files.set('https://assets.test/image.png', { text: 'image', type: 'image/png' });
  expect((await f.run()).complete).toBe(true);
  const output = await readFile(join(f.root, 'output/index.md'), 'utf8');
  expect(output).toContain('![图片](./assets/');
  expect(output).toContain('[普通链接][shared]');
  expect(output).toContain('[shared]: https://assets.test/image.png');
  const blob = await fixture('<img src="blob:https://fixture.invalid/temporary">');
  expect((await blob.run()).complete).toBe(false);
});
