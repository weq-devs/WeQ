// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it('桌面开发中的内置 Web 子构建使用 production，不修改父进程环境', () => {
  const directory = mkdtempSync(join(tmpdir(), 'weq-web-build-env-'));
  try {
    const pnpm = join(directory, 'pnpm.mjs');
    writeFileSync(
      pnpm,
      'process.stdout.write(JSON.stringify({env:process.env.NODE_ENV,marker:process.env.WEQ_BUILD_FIXTURE,args:process.argv.slice(2)}));',
    );
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import assert from 'node:assert/strict';
        const {config}=await (await import('electron-vite')).loadConfigFromFile({command:'serve',mode:'development'});
        process.env.npm_execpath=${JSON.stringify(pnpm)};
        const plugin=config.main.plugins.find(p=>p?.name==='weq-remote-web-assets');
        await plugin.buildStart();
        assert.equal(process.env.NODE_ENV,'development');`,
      ],
      {
        cwd: resolve(__dirname, '..'),
        env: {
          ...process.env,
          NODE_ENV: 'development',
          NODE_ENV_ELECTRON_VITE: 'production',
          WEQ_BUILD_FIXTURE: 'preserved',
        },
        encoding: 'utf8',
        timeout: 15_000,
      },
    );
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({
      env: 'production',
      marker: 'preserved',
      args: ['--filter', '@weq/web', 'exec', 'vite', 'build'],
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);

it('真实 Web 构建将工具和聊天附属面板留在按需分块，不进入首屏或主界面静态依赖', () => {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const {build}=await import('vite');
      const result=await build({configFile:'vite.config.ts',logLevel:'silent',build:{write:false,reportCompressedSize:false}});
      const chunks=result.output.filter(c=>c.type==='chunk');
      const visited=new Set();
      const visit=c=>{if(visited.has(c.fileName))return;visited.add(c.fileName);for(const name of c.imports){const next=chunks.find(c=>c.fileName===name);if(next)visit(next);}};
      for(const chunk of chunks.filter(c=>c.isEntry))visit(chunk);
      const firstScreen=chunks.filter(c=>visited.has(c.fileName)).flatMap(c=>Object.keys(c.modules));
      for(const chunk of chunks.filter(c=>c.facadeModuleId?.endsWith('MainView.tsx')))visit(chunk);
      console.log(JSON.stringify({firstScreen,initial:chunks.filter(c=>visited.has(c.fileName)).flatMap(c=>Object.keys(c.modules)),all:chunks.flatMap(c=>Object.keys(c.modules)),large:chunks.filter(c=>Buffer.byteLength(c.code)>500000).map(c=>({name:c.name,bytes:Buffer.byteLength(c.code),modules:Object.keys(c.modules)}))}));`,
    ],
    {
      cwd: resolve(__dirname, '../../web'),
      env: { ...process.env, NODE_ENV: 'production' },
      encoding: 'utf8',
      timeout: 45_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  const modules: {
    firstScreen: string[];
    initial: string[];
    all: string[];
    large: { name: string; bytes: number; modules: string[] }[];
  } = JSON.parse(child.stdout);
  for (const suffix of [
    '/views/MainView.tsx',
    '/components/QqMessageContent.tsx',
    '/components/ForwardWindowContent.tsx',
  ]) {
    expect(
      modules.firstScreen.some((id) => id.replaceAll('\\', '/').endsWith(suffix)),
      `首屏不得提前载入 ${suffix}`,
    ).toBe(false);
  }
  for (const suffix of [
    '/components/DbRepairPanel.tsx',
    '/components/ForwardWindowContent.tsx',
    '/components/CapturePanel.tsx',
    '/components/UdpCapturePanel.tsx',
    '/components/gift/GiftMallPanel.tsx',
    '/components/gift/GroupGiftPanel.tsx',
    '/components/gift/groupGiftFallback.ts',
    '/template/arkPanel.tsx',
    '/template/redPacketPanel.tsx',
    '/template/locationCardPanel.tsx',
    '/template/locationSharePanel.tsx',
    '/views/MailView.tsx',
    '/components/mergeForward/CompositionWorkspace.tsx',
    '/components/mergeForward/MergeForwardDialog.tsx',
    '/components/compose/AddMessageModal.tsx',
    '/components/compose/DeletedMessagesModal.tsx',
    '/components/compose/GapMessagesModal.tsx',
    '/components/compose/RecalledMessagesModal.tsx',
    '/components/search/ChatRecordsModal.tsx',
  ]) {
    expect(
      modules.all.some((id) => id.replaceAll('\\', '/').endsWith(suffix)),
      suffix,
    ).toBe(true);
    expect
      .soft(
        modules.initial.some((id) => id.replaceAll('\\', '/').endsWith(suffix)),
        suffix,
      )
      .toBe(false);
  }
  for (const chunk of modules.large) {
    expect
      .soft(
        chunk.modules.every((id) => /node_modules[\\/]@shikijs[\\/]langs[\\/]/.test(id)),
        `${chunk.name}: ${chunk.bytes} bytes，业务脚本必须低于 500 kB`,
      )
      .toBe(true);
  }
}, 50_000);
