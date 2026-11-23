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
    import { QueryClient, QueryClientProvider, useQuery, dehydrate } from '@tanstack/react-query';
    import { WebBusinessCache } from './src/renderer/src/components/WebBusinessCache';
    import { businessCacheStore, configureBusinessCache, restoreBusinessCache } from './src/renderer/src/lib/webBusinessCache';
    import { localBusinessCache } from './src/renderer/src/lib/webBusinessCacheStore';
    const key = name => [['account', name], {type:'query'}];
    const emojiKey = [['account','emojiPanel','overview'],{type:'query'}];
    let active;
    const refresh = [];
    function List() {
      const profiles = useQuery({queryKey:key('listProfiles'), queryFn:()=>new Promise((resolve,reject)=>refresh.push({resolve,reject})), retry:false, staleTime:0, refetchOnMount:true});
      const contacts = useQuery({queryKey:key('listRecentContacts'), queryFn:()=>new Promise((resolve,reject)=>refresh.push({resolve,reject})), retry:false, staleTime:0, refetchOnMount:true});
      const emoji = useQuery({queryKey:emojiKey, queryFn:()=>new Promise((resolve,reject)=>refresh.push({resolve,reject})), retry:false});
      return <main><h1>{profiles.data?.[0]?.remark ?? 'pending'}</h1><p>{contacts.data?.items?.[0]?.preview ?? 'pending'}</p><output>{profiles.data?.length ?? 0}</output><aside>{emoji.data?.faces?.[0]?.label ?? 'pending'}</aside></main>;
    }
    window.fixture = {
      async seed(scope) {
        const client = new QueryClient();
        client.setQueryData(key('listProfiles'), Array.from({length:8000},(_,i)=>({uid:'synthetic-'+i,remark:i?'name-'+i:'缓存备注'})), {updatedAt:1});
        client.setQueryData(key('listRecentContacts'), {items:[{preview:'缓存会话摘要'}]}, {updatedAt:1});
        client.setQueryData(emojiKey, {faces:[{label:'缓存系统表情',items:[{id:'synthetic-face'}]}],recent:[],favorites:[],tags:[]}, {updatedAt:1});
        // 写入版本 1 的真实对象库，重启后走正式升级路径。
        await new Promise((resolve,reject) => {
          const request = indexedDB.open('weq-business-cache', 1);
          request.onupgradeneeded = () => request.result.createObjectStore('snapshots',{keyPath:'scope'}).createIndex('savedAt','savedAt');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction('snapshots','readwrite');
            tx.objectStore('snapshots').put({scope,savedAt:1,state:dehydrate(client)});
            tx.onabort = () => reject(tx.error);
            tx.oncomplete = () => { db.close(); resolve(); };
          };
        });
        client.clear();
      },
      mount(scope) {
        active = new QueryClient({defaultOptions:{queries:{refetchOnMount:false}}});
        configureBusinessCache(active);
        createRoot(document.getElementById('root')).render(<QueryClientProvider client={active}><WebBusinessCache scope={scope} fallback={<p>pending</p>}><List/></WebBusinessCache></QueryClientProvider>);
      },
      failRefresh() { for (const item of refresh.splice(0)) item.reject(new Error('synthetic offline')); },
      refreshCount() {return refresh.length},
      update() { active.removeQueries({queryKey:emojiKey}); active.setQueryData(key('listProfiles'), [{uid:'synthetic-0',remark:'订阅更新后的备注'}]); window.dispatchEvent(new Event('pagehide')); },
      delta() {
        const put = IDBObjectStore.prototype.put;
        window.writtenQueries = [];
        IDBObjectStore.prototype.put = function (value, ...args) {
          if (this.name==='queries') window.writtenQueries.push(value.query.queryKey[0][1]);
          return put.call(this,value,...args);
        };
        active.setQueryData(key('listRecentContacts'), {items:[{preview:'仅更新本查询'}]});
        window.dispatchEvent(new Event('pagehide'));
      },
      async readContacts(scope) {
        const snap = await localBusinessCache.get(scope);
        return snap?.state.queries.find(({queryKey})=>queryKey[0][1]==='listRecentContacts')?.state.data;
      },
      async atomicWrites() {
        const state = new QueryClient();
        const scope = 'atomic';
        state.setQueryData(key('listProfiles'), ['older']);
        state.setQueryData(key('listRecentContacts'), ['stable']);
        await localBusinessCache.put({scope,savedAt:1,state:dehydrate(state)}, {revision:'one',changed:new Set()});
        state.setQueryData(key('listProfiles'), [() => null]);
        let failed = false;
        try {
          const snapshot = dehydrate(state);
          await localBusinessCache.put({scope,savedAt:2,state:snapshot}, {base:'one',revision:'two',changed:new Set(snapshot.queries.map(q=>q.queryHash))});
        } catch { failed = true; }
        const previous = await localBusinessCache.get(scope);
        state.setQueryData(key('listProfiles'), ['newer']);
        const snapshot = dehydrate(state);
        // 上一事务未提交，增量版本失配时完整恢复。
        await localBusinessCache.put({scope,savedAt:3,state:snapshot}, {base:'two',revision:'three',changed:new Set()});
        const next = await localBusinessCache.get(scope);
        await localBusinessCache.put({scope,savedAt:2,state:previous.state});
        const late = await localBusinessCache.get(scope);
        for (let i=0;i<4;i++)
          await localBusinessCache.put({scope:scope+'-'+i,savedAt:4+i,state:snapshot});
        const evicted = await localBusinessCache.get(scope);
        state.clear();
        return {failed, previous:previous?.state.queries[0].state.data, next:next?.state.queries.map(q=>q.state.data), late:late?.savedAt, evicted:!evicted};
      },
      async nativeRecords() {
        const account = 'native-fixture';
        const scope = JSON.stringify([location.origin, account]);
        const client = new QueryClient();
        const calls = [];
        let received;
        Object.defineProperty(window, 'weqRemoteBusinessRecords', {value:1, configurable:true});
        Object.defineProperty(window, 'webkit', {configurable:true, value:{messageHandlers:{weqBusinessCache:{
          async postMessage(message) {
            calls.push([message.action, message.base ?? null, message.records?.length ?? 0]);
            if (message.action === 'getRecords') return {scope:account, savedAt:3, records:received};
            if (message.base === 'seed') return 'needsFull';
            received = message.records;
            return 'stored';
          },
        }}}});
        try {
          client.setQueryData(key('listProfiles'), {value:BigInt(42)});
          client.setQueryData(key('listRecentContacts'), ['before']);
          await businessCacheStore.put({scope,savedAt:1,state:dehydrate(client)}, {revision:'seed',changed:new Set()});
          client.setQueryData(key('listRecentContacts'), ['after']);
          const state = dehydrate(client);
          const hash = state.queries.find(({queryKey})=>queryKey[0][1]==='listRecentContacts').queryHash;
          await businessCacheStore.put({scope,savedAt:2,state}, {base:'seed',revision:'patch',changed:new Set([hash])});
          const restored = await businessCacheStore.get(scope);
          return {calls, savedAt:restored?.savedAt, contents:restored?.state.queries.map(q=>q.state.data)};
        } finally {
          delete window.weqRemoteBusinessRecords;
          delete window.webkit;
          client.clear();
        }
      },
      async read(scope) {const c=new QueryClient(); await restoreBusinessCache(c,scope); const result=c.getQueryData(key('listProfiles')); c.clear(); return result},
    };
  `,
  },
  bundle: true,
  write: false,
  format: 'iife',
  jsx: 'automatic',
  platform: 'browser',
  alias: { '@transport': resolve(root, 'test/support/transport.stub.ts') },
  loader: { '.css': 'empty' },
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.VITE_WEQ_TARGET': '"web"' },
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
      assert.equal(await page.locator('aside').textContent(), '缓存系统表情');
      await page.waitForFunction(() => window.fixture.refreshCount() === 3);
      await page.evaluate(() => window.fixture.failRefresh());
      assert.equal(await page.getByRole('heading').textContent(), '缓存备注');
      assert.equal(await page.locator('aside').textContent(), '缓存系统表情');
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
      await page.evaluate(() => window.fixture.delta());
      await page.waitForFunction(
        async () =>
          (await window.fixture.readContacts('computer-a/account-a/config-a'))?.items?.[0]
            ?.preview === '仅更新本查询',
      );
      assert.deepEqual(await page.evaluate(() => window.writtenQueries), ['listRecentContacts']);
      assert.deepEqual(await page.evaluate(() => window.fixture.atomicWrites()), {
        failed: true,
        previous: ['older'],
        next: [['newer'], ['stable']],
        late: 3,
        evicted: true,
      });
      await page.reload();
      await page.evaluate(() => window.fixture.mount('computer-a/account-a/config-a'));
      await page.getByRole('heading', { name: '订阅更新后的备注', exact: true }).waitFor();
      assert.equal(await page.locator('aside').textContent(), '缓存系统表情');
      assert.deepEqual(await page.evaluate(() => window.fixture.nativeRecords()), {
        calls: [
          ['putRecords', null, 2],
          ['putRecords', 'seed', 1],
          ['putRecords', null, 2],
          ['getRecords', null, 0],
        ],
        savedAt: 3,
        contents: [{ value: 42n }, ['after']],
      });
      console.log(
        JSON.stringify({
          browser: name,
          restart: true,
          profiles: 8000,
          cachedFirst: true,
          refreshFailureRetained: true,
          accountIsolation: true,
          subscriptionPersisted: true,
          migratedVersionOne: true,
          onlyChangedQueryWritten: true,
          transactionLossRecovered: true,
          nativeRecordsReplayed: true,
          emojiRestartCache: true,
          emojiRetainedAfterMemoryRemoval: true,
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
