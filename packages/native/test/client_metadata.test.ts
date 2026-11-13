import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createClientMetadataReader } from '../src/client_metadata';
import { InitStatus, type NtHelperBinding } from '../src/types';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const metadata = { appid: '123', version: '7.0.2', build: '200' };

function fixture(source?: string) {
  const root = mkdtempSync(join(tmpdir(), 'weq-client-meta-'));
  roots.push(root);
  const addon = join(root, 'fake-addon.cjs'),
    major = join(root, 'major.node');
  writeFileSync(major, JSON.stringify(metadata));
  writeFileSync(
    addon,
    source ??
      `const fs=require('node:fs');module.exports={getInitStatus:()=>${InitStatus.Success},resolveAppidFromMajor:(path)=>{const value=JSON.parse(fs.readFileSync(path,'utf8'));fs.appendFileSync(path+'.calls','1\\n');fs.writeFileSync(path+'.entered',value.build);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,120);return value;}}`,
  );
  const sync = vi.fn(() => {
    throw new Error('不应在父进程扫描');
  });
  const nt = { resolveAppidFromMajor: sync } as unknown as NtHelperBinding;
  return { root, addon, major, nt, sync };
}

it('元数据读取在子进程完成，父进程先处理事件，重复在途请求复用同一次读取', async () => {
  const f = fixture(),
    read = createClientMetadataReader(
      () => f.addon,
      () => f.root,
    );
  const a = read(f.nt, f.major),
    b = read(f.nt, f.major);
  expect(
    await Promise.race([
      a.then(() => 'metadata'),
      new Promise((resolve) => setImmediate(() => resolve('tick'))),
    ]),
  ).toBe('tick');
  expect(await a).toMatchObject(metadata);
  expect(await b).toMatchObject(metadata);
  expect(
    readFileSync(f.major + '.calls', 'utf8')
      .trim()
      .split('\n'),
  ).toHaveLength(1);
  expect(f.sync).not.toHaveBeenCalled();
});

it('文件替换后的请求不复用旧文件版本的在途结果', async () => {
  const f = fixture(),
    read = createClientMetadataReader(
      () => f.addon,
      () => f.root,
    );
  const first = read(f.nt, f.major);
  const until = Date.now() + 5000;
  while (!existsSync(f.major + '.entered') && Date.now() < until)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(readFileSync(f.major + '.entered', 'utf8')).toBe('200');
  const next = join(f.root, 'replacement.node');
  writeFileSync(next, JSON.stringify({ ...metadata, build: '300' }));
  renameSync(next, f.major);
  const second = read(f.nt, f.major);
  expect(await first).toMatchObject(metadata);
  expect(await second).toMatchObject({ ...metadata, build: '300' });
});

it('原生初始化失败与无效输出均拒绝，超时子进程退出后可以重试', async () => {
  const f = fixture(`module.exports={getInitStatus:()=>${InitStatus.Expired}}`);
  const read = createClientMetadataReader(
    () => f.addon,
    () => f.root,
    1000,
  );
  await expect(read(f.nt, f.major)).rejects.toThrow('native initialization failed');
  writeFileSync(
    f.addon,
    `module.exports={getInitStatus:()=>${InitStatus.Success},resolveAppidFromMajor:()=>({appid:123})}`,
  );
  await expect(read(f.nt, f.major)).rejects.toThrow('App ID');
  writeFileSync(
    f.addon,
    `module.exports={getInitStatus:()=>${InitStatus.Success},resolveAppidFromMajor:()=>{setInterval(()=>{},1000);return {appid:'123'};}}`,
  );
  await expect(read(f.nt, f.major)).rejects.toMatchObject({ killed: true });
  writeFileSync(
    f.addon,
    `module.exports={getInitStatus:()=>${InitStatus.Success},resolveAppidFromMajor:()=>({appid:'123'})}`,
  );
  await expect(read(f.nt, f.major)).resolves.toMatchObject({ appid: '123' });
});

it('未经过原生加载器的测试绑定保留原接口，不启动不明组件', async () => {
  const sync = vi.fn(() => metadata),
    read = createClientMetadataReader(() => undefined);
  expect(await read({ resolveAppidFromMajor: sync }, '/synthetic/major.node')).toEqual(metadata);
  expect(sync).toHaveBeenCalledOnce();
});
