/**
 * OneBot 配置的读取、迁移与备份。
 *
 * 2026-11-19 起有两处结构变化：
 *
 *   1. **按账号存**：`oneBotByUin[uin]`（之前是全局一份 `oneBot`）；
 *   2. **形状与 weqbot kernel 同构**：`networks` 四类（之前是
 *      `webSocketServers` / `httpServers` 两组）。
 *
 * WeQ 只负责编辑与保存，执行在 weqbot daemon。所以这里测的是**所有历史格式
 * 都能读进来**，以及旧版全局配置不会在升级后凭空消失。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  snapshotWeqApiSettings,
  snapshotWeqSettings,
  validateWeqApiSettings,
} from '../src/bootstrap/backup_settings';
import { DEFAULT_SERVICE_PORTS } from '../src/common/service_ports';
import { configFixture } from './support/user_config';

const EMPTY = { networks: { wsServers: [], wsClients: [], httpServers: [], httpClients: [] } };

function saveAccounts(root: string, ...uins: string[]): void {
  const dir = join(root, 'config', 'accounts');
  mkdirSync(dir, { recursive: true });
  for (const uin of uins) {
    writeFileSync(join(dir, `${uin}.json`), JSON.stringify({ uin, lastLoginAt: 1 }));
  }
}

it('默认没有任何账号的配置，且与 MCP 互不影响', () => {
  const f = configFixture({
    settings: { mcp: { enabled: true, port: 40000, token: 'synthetic-mcp' } },
  });
  expect(f.service.getSettings().oneBotByUin).toEqual({});
  expect(f.service.getSettings().mcp).toEqual({
    enabled: true,
    port: 40000,
    token: 'synthetic-mcp',
  });
});

it('按账号存，互不覆盖', () => {
  const f = configFixture({ settings: {} });
  f.service.setSettings({
    oneBotByUin: {
      10001: {
        networks: {
          wsServers: [{ name: 'a', port: 6700, messageFormat: 'array', reportSelfMessage: true }],
          wsClients: [],
          httpServers: [],
          httpClients: [],
        },
      },
      10002: {
        networks: {
          wsServers: [{ name: 'b', port: 6800, messageFormat: 'array', reportSelfMessage: true }],
          wsClients: [],
          httpServers: [],
          httpClients: [],
        },
      },
    },
  });
  const map = f.open().getSettings().oneBotByUin;
  expect(map['10001']?.networks.wsServers[0]?.port).toBe(6700);
  expect(map['10002']?.networks.wsServers[0]?.port).toBe(6800);
});

it('新格式原样保留四类网络（含反向 WS 与 HTTP 上报）', () => {
  const f = configFixture({
    settings: {
      oneBotByUin: {
        10001: {
          networks: {
            wsServers: [
              { name: 'client', port: 6700, messageFormat: 'array', reportSelfMessage: true },
            ],
            wsClients: [
              {
                name: 'reverse',
                url: 'ws://127.0.0.1:6701/',
                messageFormat: 'array',
                reportSelfMessage: true,
              },
            ],
            httpServers: [],
            httpClients: [],
          },
          qzone: false,
        },
      },
    },
  });
  const config = f.open().getSettings().oneBotByUin['10001']!;
  expect(config.networks.wsServers[0]?.port).toBe(6700);
  expect(config.networks.wsClients[0]?.url).toBe('ws://127.0.0.1:6701/');
  expect(config.qzone).toBe(false);
});

it('同名条目只留第一条（页面靠名字区分卡片）', () => {
  const f = configFixture({
    settings: {
      oneBotByUin: {
        10001: {
          networks: {
            wsServers: [
              { name: 'dup', port: 6700, messageFormat: 'array', reportSelfMessage: true },
              { name: 'dup', port: 6701, messageFormat: 'array', reportSelfMessage: true },
            ],
            wsClients: [],
            httpServers: [],
            httpClients: [],
          },
        },
      },
    },
  });
  const servers = f.open().getSettings().oneBotByUin['10001']!.networks.wsServers;
  expect(servers).toHaveLength(1);
  expect(servers[0]?.port).toBe(6700);
});

it('单个账号配置里的旧旧格式（单条 port / token）也会迁移', () => {
  const f = configFixture({
    settings: {
      oneBotByUin: {
        10001: { enabled: true, port: 51234, token: 'legacy-token' },
      },
    },
  });
  expect(f.open().getSettings().oneBotByUin['10001']).toEqual({
    networks: {
      wsServers: [
        {
          name: 'WebSocket 服务器',
          enabled: true,
          port: 51234,
          accessToken: 'legacy-token',
          messageFormat: 'array',
          reportSelfMessage: true,
        },
      ],
      wsClients: [],
      httpServers: [],
      httpClients: [],
    },
  });
});

it('单个账号配置里的旧格式（两组数组）保留端口与令牌', () => {
  const f = configFixture({
    settings: {
      oneBotByUin: {
        10001: {
          enabled: true,
          webSocketServers: [
            { id: 'old-ws', name: '原 WS', enabled: true, port: 48766, token: 'old-token' },
          ],
          httpServers: [
            {
              id: 'old-http',
              name: '原 HTTP',
              enabled: true,
              port: 48767,
              token: 'http-token',
              enableCors: false,
            },
          ],
        },
      },
    },
  });
  const config = f.open().getSettings().oneBotByUin['10001']!;
  expect(config.networks.wsServers[0]).toMatchObject({ port: 48766, accessToken: 'old-token' });
  expect(config.networks.httpServers[0]).toMatchObject({
    port: 48767,
    accessToken: 'http-token',
    enableCors: false,
  });
});

it('旧版全局 oneBot 迁移到 legacy 键，不会凭空消失', () => {
  const f = configFixture({
    settings: { oneBot: { enabled: true, port: 51234, token: 'legacy-token' } },
  });
  const map = f.open().getSettings().oneBotByUin;
  expect(map.legacy).toEqual({
    networks: {
      wsServers: [
        {
          name: 'WebSocket 服务器',
          enabled: true,
          port: 51234,
          accessToken: 'legacy-token',
          messageFormat: 'array',
          reportSelfMessage: true,
        },
      ],
      wsClients: [],
      httpServers: [],
      httpClients: [],
    },
  });
});

it('账号启用 OneBot 时接续唯一账号的旧监听端口和令牌', () => {
  const f = configFixture({
    settings: {
      oneBot: {
        enabled: true,
        webSocketServers: [
          { id: 'legacy-a', name: '主 WS', enabled: true, port: 51234, token: 'legacy-token' },
          { id: 'legacy-b', name: '主 WS', enabled: true, port: 51235, token: 'other-token' },
        ],
      },
    },
  });
  saveAccounts(f.root, '10001');
  f.open().oneBotConfigOnAccountOpen('10001');
  const migrated = f.open().getSettings().oneBotByUin;
  expect(migrated['10001']?.networks.wsServers).toMatchObject([
    { name: '主 WS', enabled: true, port: 51234, accessToken: 'legacy-token' },
    { name: '主 WS (2)', enabled: true, port: 51235, accessToken: 'other-token' },
  ]);
  expect(Object.keys(migrated)).toEqual(['10001']);
});

it('多个账号不自动领取旧全局配置，保存新配置时保留其他账号和旧配置', () => {
  const f = configFixture({
    settings: { oneBot: { enabled: true, port: 51234, token: 'legacy-token' } },
  });
  saveAccounts(f.root, '10001', '10002');
  const config = f.open();
  expect(config.oneBotConfigOnAccountOpen('10001')).toBeUndefined();
  config.saveAccountOneBotConfig('10001', EMPTY);
  config.saveAccountOneBotConfig('10002', EMPTY);
  const settings = f.open().getSettings();
  expect(Object.keys(settings.oneBotByUin)).toEqual(['10001', '10002', 'legacy']);
  expect(settings.oneBotByUin.legacy?.networks.wsServers[0]?.accessToken).toBe('legacy-token');
  expect(() => validateWeqApiSettings(snapshotWeqApiSettings(settings))).not.toThrow();
});

it('旧全局总开关关闭时，迁移不会重新打开已配置的端口', () => {
  const f = configFixture({
    settings: {
      oneBot: {
        enabled: false,
        webSocketServers: [{ name: 'WS', port: 6700, enabled: true, token: 'ws-token' }],
        httpServers: [
          { name: 'HTTP', port: 6701, enabled: true, token: 'http-token', enableCors: true },
        ],
      },
    },
  });
  saveAccounts(f.root, '10001');
  const config = f.open().oneBotConfigOnAccountOpen('10001');
  expect(config?.networks.wsServers[0]).toMatchObject({ enabled: false, port: 6700 });
  expect(config?.networks.httpServers[0]).toMatchObject({
    enabled: false,
    port: 6701,
    enableCors: true,
  });
});

it('已有按账号配置时，旧全局配置不再覆盖', () => {
  const f = configFixture({
    settings: {
      oneBot: { enabled: true, port: 51234, token: 'legacy-token' },
      oneBotByUin: {
        10001: {
          networks: {
            wsServers: [
              { name: 'cur', port: 6700, messageFormat: 'array', reportSelfMessage: true },
            ],
            wsClients: [],
            httpServers: [],
            httpClients: [],
          },
        },
      },
    },
  });
  const map = f.open().getSettings().oneBotByUin;
  expect(Object.keys(map)).toEqual(['10001']);
  expect(map['10001']?.networks.wsServers[0]?.port).toBe(6700);
});

it('非法 uin 键被丢弃（不会污染配置）', () => {
  const f = configFixture({
    settings: {
      oneBotByUin: {
        'not-a-uin': {
          networks: { wsServers: [], wsClients: [], httpServers: [], httpClients: [] },
        },
        10001: { networks: { wsServers: [], wsClients: [], httpServers: [], httpClients: [] } },
      },
    },
  });
  expect(Object.keys(f.open().getSettings().oneBotByUin)).toEqual(['10001']);
});

it('OneBot 配置进 API 备份分区，新旧备份都能校验', () => {
  const f = configFixture({ settings: {} });
  f.service.setSettings({
    oneBotByUin: {
      10001: {
        networks: {
          wsServers: [
            {
              name: '主 WS',
              enabled: true,
              port: 48767,
              accessToken: 'synthetic-onebot',
              messageFormat: 'array',
              reportSelfMessage: true,
            },
          ],
          wsClients: [],
          httpServers: [],
          httpClients: [],
        },
      },
    },
  });
  const settings = f.service.getSettings();
  expect(snapshotWeqSettings(settings)).not.toHaveProperty('oneBotByUin');
  const api = snapshotWeqApiSettings(settings);
  expect(api.oneBotByUin).toEqual(settings.oneBotByUin);
  expect(() => validateWeqApiSettings(api)).not.toThrow();
  const { oneBotByUin: _one, ...withoutOneBot } = api;
  expect(() => validateWeqApiSettings(withoutOneBot)).not.toThrow();

  // 旧备份（全局一份 + 旧形状）必须能导入 —— 用户资产不能因为格式升级作废。
  expect(() =>
    validateWeqApiSettings({ oneBot: { enabled: true, port: 51234, token: '' } }),
  ).not.toThrow();
  expect(() =>
    validateWeqApiSettings({
      oneBot: {
        enabled: true,
        webSocketServers: [{ id: 'ws-main', name: '主 WS', enabled: true, port: 48767, token: '' }],
        httpServers: [],
      },
    }),
  ).not.toThrow();

  // 明显的坏值仍然要拒。
  expect(() => validateWeqApiSettings({ oneBot: { enabled: true, port: 0, token: '' } })).toThrow(
    'api.oneBot.port',
  );
  expect(() =>
    validateWeqApiSettings({
      oneBotByUin: {
        10001: {
          networks: {
            wsServers: [{ name: 'x', port: 6700, messageFormat: 'array' }],
            wsClients: [],
            httpServers: [],
            httpClients: [],
          },
        },
      },
    }),
  ).toThrow('reportSelfMessage');
  expect(() =>
    validateWeqApiSettings({
      oneBotByUin: { 'not-a-uin': EMPTY },
    }),
  ).toThrow('api.oneBotByUin.not-a-uin');
});

it('缺省端口常量仍指向 OneBot 的历史默认值', () => {
  // 旧格式迁移会用它们兜底；改这两个常量等于让老用户的配置换端口。
  expect(DEFAULT_SERVICE_PORTS['onebot-ws']).toBe(48800);
  expect(DEFAULT_SERVICE_PORTS['onebot-http']).toBe(48840);
});
