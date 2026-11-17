// @vitest-environment node
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SiQzone } from 'react-icons/si';
import { AiOutlineRedEnvelope } from 'react-icons/ai';
import { createServer } from 'vite';
import { expect, it } from 'vitest';
import webConfig from '../../web/vite.config';

it('开发 Web 只交付选用的图标，保持原库的图形和属性', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-icon-subset-'));
  const selected = resolve(__dirname, '../src/renderer/src/lib/reactIcons.ts');
  const server = await createServer({
    ...webConfig,
    configFile: false,
    root,
    cacheDir: join(root, 'cache'),
    logLevel: 'silent',
    optimizeDeps: { entries: [join(root, 'index.html')], include: ['react'] },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [root, resolve(__dirname, '../../..')] } },
  });
  try {
    await symlink(
      resolve(__dirname, '../node_modules'),
      join(root, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await writeFile(join(root, 'index.html'), '<script type="module" src="/main.js"></script>');
    await writeFile(
      join(root, 'main.js'),
      `import {SiQzone,AiOutlineRedEnvelope} from ${JSON.stringify(selected)};console.log(SiQzone,AiOutlineRedEnvelope);`,
    );
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === 'string') throw new Error('缺少开发监听地址');
    const body = await (await fetch(`http://127.0.0.1:${address.port}/@fs/${selected}`)).text();
    expect(body).toContain('SiQzone');
    expect(body).toContain('AiOutlineRedEnvelope');
    expect(body).not.toMatch(/(?:from|import)\s*["'][^"']*react-icons/);
    expect(body).not.toMatch(/react-icons_(?:si|ai)\.js/);
    expect(gzipSync(body).length).toBeLessThan(5000);
    const icons = await server.ssrLoadModule(selected);
    const props = { size: 24, color: '#123456', strokeWidth: 0, 'aria-hidden': true as const };
    for (const [name, original] of Object.entries({ SiQzone, AiOutlineRedEnvelope })) {
      expect(renderToStaticMarkup(createElement(icons[name], props))).toBe(
        renderToStaticMarkup(createElement(original, props)),
      );
    }
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
