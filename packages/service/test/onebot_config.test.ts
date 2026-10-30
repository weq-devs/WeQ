import { expect, it } from 'vitest';
import { configFixture } from './support/user_config';
import {
  snapshotWeqSettings,
  snapshotWeqApiSettings,
  validateWeqApiSettings,
} from '../src/bootstrap/backup_settings';

it('defaults OneBot to disabled with one disabled WebSocket server and keeps edits independent of MCP', () => {
  const f = configFixture({
    settings: { mcp: { enabled: true, port: 40000, token: 'synthetic-mcp' } },
  });
  expect(f.service.getSettings().oneBot).toEqual({
    enabled: false,
    webSocketServers: [
      { id: 'ws-default', name: 'WebSocket 服务器', enabled: false, port: 48766, token: '' },
    ],
    httpServers: [],
  });
  f.service.setSettings({
    oneBot: {
      enabled: true,
      webSocketServers: [
        {
          id: 'ws-main',
          name: '主 WS',
          enabled: true,
          port: 48767,
          token: 'synthetic-onebot',
        },
      ],
    },
  });
  f.service.setSettings({
    oneBot: {
      httpServers: [
        {
          id: 'http-main',
          name: 'HTTP API',
          enabled: true,
          port: 48768,
          token: 'synthetic-http',
          enableCors: true,
        },
      ],
    },
  });
  expect(f.open().getSettings().oneBot).toEqual({
    enabled: true,
    webSocketServers: [
      {
        id: 'ws-main',
        name: '主 WS',
        enabled: true,
        port: 48767,
        token: 'synthetic-onebot',
      },
    ],
    httpServers: [
      {
        id: 'http-main',
        name: 'HTTP API',
        enabled: true,
        port: 48768,
        token: 'synthetic-http',
        enableCors: true,
      },
    ],
  });
  expect(f.open().getSettings().mcp).toEqual({
    enabled: true,
    port: 40000,
    token: 'synthetic-mcp',
  });
});

it('migrates the legacy single WebSocket config without losing its port or token', () => {
  const f = configFixture({
    settings: { oneBot: { enabled: true, port: 51234, token: 'legacy-token' } },
  });
  expect(f.open().getSettings().oneBot).toEqual({
    enabled: true,
    webSocketServers: [
      {
        id: 'ws-default',
        name: 'WebSocket 服务器',
        enabled: true,
        port: 51234,
        token: 'legacy-token',
      },
    ],
    httpServers: [],
  });
});

it('still migrates legacy fields when deep-merging an old backup over a newer config', () => {
  const f = configFixture({
    settings: {
      oneBot: {
        enabled: true,
        port: 51234,
        token: 'legacy-token',
        webSocketServers: [
          {
            id: 'newer-ws',
            name: '本机新配置',
            enabled: true,
            port: 48767,
            token: 'newer-token',
          },
        ],
        httpServers: [],
      },
    },
  });
  expect(f.open().getSettings().oneBot).toEqual({
    enabled: true,
    webSocketServers: [
      {
        id: 'ws-default',
        name: 'WebSocket 服务器',
        enabled: true,
        port: 51234,
        token: 'legacy-token',
      },
    ],
    httpServers: [],
  });
});

it('places OneBot config in the API backup partition and accepts legacy or multi-server backups', () => {
  const f = configFixture({ settings: {} });
  f.service.setSettings({
    oneBot: {
      webSocketServers: [
        {
          id: 'ws-main',
          name: '主 WS',
          enabled: true,
          port: 48767,
          token: 'synthetic-onebot',
        },
      ],
      httpServers: [
        {
          id: 'http-main',
          name: 'HTTP API',
          enabled: false,
          port: 48768,
          token: 'synthetic-http',
          enableCors: false,
        },
      ],
    },
  });
  const settings = f.service.getSettings();
  expect(snapshotWeqSettings(settings)).not.toHaveProperty('oneBot');
  const api = snapshotWeqApiSettings(settings);
  expect(api.oneBot).toEqual(settings.oneBot);
  expect(() => validateWeqApiSettings(api)).not.toThrow();
  const { oneBot: _oneBot, ...old } = api;
  expect(() => validateWeqApiSettings(old)).not.toThrow();
  expect(() =>
    validateWeqApiSettings({ oneBot: { enabled: true, port: 51234, token: '' } }),
  ).not.toThrow();
  expect(() => validateWeqApiSettings({ oneBot: { enabled: true, port: 0, token: '' } })).toThrow(
    'api.oneBot.port',
  );
  expect(() =>
    validateWeqApiSettings({
      oneBot: {
        enabled: true,
        webSocketServers: [
          {
            id: 'ws-main',
            name: '主 WS',
            enabled: true,
            port: 48767,
            token: '',
          },
        ],
        httpServers: [
          {
            id: 'http-main',
            name: 'HTTP API',
            enabled: true,
            port: 48768,
            token: '',
            enableCors: 'yes',
          },
        ],
      },
    }),
  ).toThrow('api.oneBot.httpServers[0].enableCors');
});
