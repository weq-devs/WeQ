import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const engines = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const bundle = await build({
  stdin: {
    resolveDir: root,
    loader: 'tsx',
    contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
    import { WebBusinessCache } from './src/renderer/src/components/WebBusinessCache';
    import { restoreBusinessCache, watchBusinessCache } from './src/renderer/src/lib/webBusinessCache';
    const key = name => [['account', name], {type:'query'}];
    let active;
    const refresh = [];
    function List() {
      const profiles = useQuery({queryKey:key('listProfiles'), queryFn:()=>new Promise((resolve,reject)=>refresh.push({resolve,reject})), retry:false, staleTime:0});
      const contacts = useQuery({queryKey:key('listRecentContacts'), queryFn:()=>new Promise((resolve,reject)=>refresh.push({resolve,reject})), retry:false, staleTime:0});
      return <main><h1>{profiles.data?.[0]?.remark ?? 'pending'}</h1><p>{contacts.data?.items?.[0]?.preview ?? 'pending'}</p><output>{profiles.data?.length ?? 0}</output></main>;
    }
    window.fixture = {
      async seed(scope) {
        const client = new QueryClient();
        const stop = watchBusinessCache(client, scope);
        client.setQueryData(key('listProfiles'), Array.from({length:8000},(_,i)=>({uid:'synthetic-'+i,remark:i?'name-'+i:'缓存备注'})), {updatedAt:1});
        client.setQueryData(key('listRecentContacts'), {items:[{preview:'缓存会话摘要'}]}, {updatedAt:1});
        await stop(); client.clear();
      },
      mount(scope) {
        active = new QueryClient();
        createRoot(document.getElementById('root')).render(<QueryClientProvider client={active}><WebBusinessCache scope={scope} fallback={<p>pending</p>}><List/></WebBusinessCache></QueryClientProvider>);
      },
      failRefresh() { for (const item of refresh.splice(0)) item.reject(new Error('synthetic offline')); },
      refreshCount() {return refresh.length},
      update() { active.setQueryData(key('listProfiles'), [{uid:'synthetic-0',remark:'订阅更新后的备注'}]); window.dispatchEvent(new Event('pagehide')); },
      async read(scope) {const c=new QueryClient(); await restoreBusinessCache(c,scope); const result=c.getQueryData(key('listProfiles')); c.clear(); return result},
    };
  `,
  },
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
});
const script = bundle.outputFiles[0].text;
const server = createServer((request, response) => {
  response.setHeader(
    'Content-Type',
    request.url === '/fixture.js' ? 'text/javascript' : 'text/html',
  );
  response.end(
    request.url === '/fixture.js'
      ? script
      : '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/fixture.js"></script>',
  );
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${server.address().port}`;
try {
  for (const name of (process.env.WEQ_CACHE_BROWSERS ?? 'chromium,webkit').split(',')) {
    const profile = await mkdtemp(resolve(tmpdir(), 'weq-business-cache-'));
    let context;
    try {
      const options = {
        headless: true,
        viewport: { width: 390, height: 844 },
        ...(name === 'chromium' && process.env.WEQ_BROWSER_EXECUTABLE
          ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
          : {}),
        ...(name === 'webkit' && process.env.WEQ_WEBKIT_EXECUTABLE
          ? { executablePath: process.env.WEQ_WEBKIT_EXECUTABLE }
          : {}),
      };
      context = await engines[name].launchPersistentContext(profile, options);
      let page = await context.newPage();
      await page.goto(url);
      await page.evaluate(() => window.fixture.seed('computer-a/account-a/config-a'));
      await context.close();
      context = undefined;
      // 真实重启浏览器上下文，不能仅凭 QueryClient 内存断言持久化。
      context = await engines[name].launchPersistentContext(profile, options);
      page = await context.newPage();
      await page.goto(url);
      await page.evaluate(() => window.fixture.mount('computer-a/account-a/config-a'));
      await page.getByRole('heading', { name: '缓存备注', exact: true }).waitFor();
      assert.equal(await page.locator('output').textContent(), '8000');
      assert.equal(await page.locator('main p').textContent(), '缓存会话摘要');
      await page.waitForFunction(() => window.fixture.refreshCount() === 2);
      await page.evaluate(() => window.fixture.failRefresh());
      assert.equal(await page.getByRole('heading').textContent(), '缓存备注');
      for (const scope of [
        'computer-b/account-a/config-a',
        'computer-a/account-b/config-a',
        'computer-a/account-a/config-b',
      ]) {
        assert.equal(await page.evaluate((scope) => window.fixture.read(scope), scope), undefined);
      }
      await page.evaluate(() => window.fixture.update());
      await page.waitForFunction(
        async () =>
          (await window.fixture.read('computer-a/account-a/config-a'))?.[0]?.remark ===
          '订阅更新后的备注',
      );
      await page.reload();
      await page.evaluate(() => window.fixture.mount('computer-a/account-a/config-a'));
      await page.getByRole('heading', { name: '订阅更新后的备注', exact: true }).waitFor();
      console.log(
        JSON.stringify({
          browser: name,
          restart: true,
          profiles: 8000,
          cachedFirst: true,
          refreshFailureRetained: true,
          accountIsolation: true,
          subscriptionPersisted: true,
        }),
      );
    } finally {
      await context?.close();
      await rm(profile, { recursive: true, force: true });
    }
  }
} finally {
  await new Promise((done) => server.close(done));
}
