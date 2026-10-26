// @vitest-environment node
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import {
  AUTHORIZATION_PROTOCOL,
  AUTHORIZATION_TARGETS,
  type AuthorizationBuildInfo,
} from '@weq/native/authorization.mjs';
import { authorizationHelperPath } from '../src/main/authorization/helper_path';
import {
  AuthorizationInstaller,
  validateHelperBuildForOperation,
} from '../src/main/authorization/install';

const elevation = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('test forbids privileged execution');
  }),
);
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: elevation,
  spawn: elevation,
}));
const cleanup: string[] = [];
afterEach(async () => {
  expect(elevation).not.toHaveBeenCalled();
  elevation.mockClear();
  for (const directory of cleanup.splice(0)) await rm(directory, { recursive: true, force: true });
});

it('仅开发模式接受本地绝对路径覆盖，支持 Windows 路径且正式版忽略覆盖', () => {
  const bundled = () => '/bundle/helper';
  expect(
    authorizationHelperPath({
      bundled,
      packaged: false,
      override: '/local/native helper',
      platform: 'darwin',
    }),
  ).toBe('/local/native helper');
  expect(
    authorizationHelperPath({
      bundled,
      packaged: false,
      override: 'C:\\local\\helper.exe',
      platform: 'win32',
    }),
  ).toBe('C:\\local\\helper.exe');
  expect(() =>
    authorizationHelperPath({
      bundled,
      packaged: false,
      override: 'relative/helper',
      platform: 'linux',
    }),
  ).toThrow('绝对路径');
  expect(
    authorizationHelperPath({
      bundled,
      packaged: true,
      override: 'relative/helper',
      platform: 'linux',
    }),
  ).toBe('/bundle/helper');
});

async function fixture({
  development = true,
  allowDevelopment = true,
  legacy = false,
  changedChannel = false,
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'authorization-development-'));
  cleanup.push(directory);
  const helper = join(directory, 'source-helper');
  await writeFile(helper, 'synthetic helper bytes, never executed');
  const platform = process.platform === 'win32' ? 'win32' : 'darwin';
  let currentDevelopment = development;
  const buildInfo = (dev: boolean): AuthorizationBuildInfo => {
    const time = Math.floor(Date.now() / 1000) - 10;
    const target = AUTHORIZATION_TARGETS[`${platform}-${process.arch}`];
    if (!target) throw new Error('unsupported synthetic platform');
    return {
      protocol: AUTHORIZATION_PROTOCOL,
      target,
      capabilities: ['attach', 'key-scan', 'capture'],
      isDev: dev,
      channel: legacy ? undefined : dev ? 'development' : 'release',
      buildTime: dev ? null : time,
      expireTime: dev ? null : time + 3600,
      validitySecs: 3600,
    };
  };
  const probe = vi.fn(async (file: string, operation: 'identity' | 'build-info') => {
    const dev = file !== helper && changedChannel ? !currentDevelopment : currentDevelopment;
    const channel = dev ? 'development' : 'release';
    return JSON.stringify(
      operation === 'build-info'
        ? buildInfo(dev)
        : {
            id: 'synthetic-user',
            root: join(directory, channel),
            development: legacy ? undefined : dev,
            endpoint:
              process.platform === 'win32'
                ? `\\\\.\\pipe\\authorization-fixture-${directory.split(/[\\/]/).pop()}-${channel}`
                : join(directory, `${channel}.sock`),
          },
    );
  });
  const installer = new AuthorizationInstaller({
    helper: () => helper,
    platform,
    allowDevelopment,
    probe,
  });
  return {
    installer,
    probe,
    helper,
    buildInfo,
    setDevelopment: (value: boolean) => {
      currentDevelopment = value;
    },
  };
}

it('开发助手可检查与连接；重编译后刷新诊断缓存，不自动安装服务', async () => {
  const data = await fixture();
  expect(await data.installer.status()).toMatchObject({
    state: 'not-installed',
    development: true,
  });
  expect(await data.installer.status()).toMatchObject({ development: true });
  expect(data.probe).toHaveBeenCalledTimes(2);
  data.setDevelopment(false);
  await writeFile(data.helper, 'new synthetic build with different size');
  expect(await data.installer.status()).toMatchObject({ development: false });
  expect(data.probe).toHaveBeenCalledTimes(4);
  expect(new Set(data.probe.mock.calls.map((call) => call[1]))).toEqual(
    new Set(['identity', 'build-info']),
  );
});

it('正式宿主拒绝开发构建，旧的未隔离开发助手需要重新编译', async () => {
  const production = await fixture({ allowDevelopment: false });
  expect(await production.installer.status()).toMatchObject({
    state: 'unavailable',
    message: '正式版不使用开发构建的权限助手',
  });
  const legacy = await fixture({ legacy: true });
  expect(await legacy.installer.status()).toMatchObject({
    state: 'unavailable',
    message: '请重新编译支持隔离开发通道的权限助手',
  });
});

it('暂存组件改变通道时在提权前停止，不误安装到另一个通道', async () => {
  const data = await fixture({ changedChannel: true });
  await expect(data.installer.install()).rejects.toThrow('助手通道发生变化');
});
it('确认后切换助手构建时不沿用旧通道的安装或撤销确认', async () => {
  const production = await fixture({ development: false });
  await expect(production.installer.install(true)).rejects.toThrow('助手通道已变化');
  const development = await fixture();
  await expect(development.installer.remove(false)).rejects.toThrow('助手通道已变化');
});

it('开发构建遵循原有 dev 策略，过期发布构建仍可撤销但不能重新安装', async () => {
  const data = await fixture();
  expect(() => validateHelperBuildForOperation(data.buildInfo(true), 'install')).not.toThrow();
  const expired = { ...data.buildInfo(false), buildTime: 1, expireTime: 2, validitySecs: 1 };
  expect(() => validateHelperBuildForOperation(expired, 'install')).toThrow('有效的发布构建');
  expect(() => validateHelperBuildForOperation(expired, 'remove')).not.toThrow();
});
