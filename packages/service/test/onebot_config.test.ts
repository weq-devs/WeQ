import { expect, it } from 'vitest';
import { configFixture } from './support/user_config';
import {
  snapshotWeqSettings,
  snapshotWeqApiSettings,
  validateWeqApiSettings,
} from '../src/bootstrap/backup_settings';

it('defaults OneBot to disabled and keeps partial edits independent of MCP', () => {
  const f = configFixture({
    settings: { mcp: { enabled: true, port: 40000, token: 'synthetic-mcp' } },
  });
  expect(f.service.getSettings().oneBot).toEqual({ enabled: false, port: 48766, token: '' });
  f.service.setSettings({ oneBot: { enabled: true, token: 'synthetic-onebot' } });
  f.service.setSettings({ oneBot: { port: 48767 } });
  expect(f.open().getSettings().oneBot).toEqual({
    enabled: true,
    port: 48767,
    token: 'synthetic-onebot',
  });
  expect(f.open().getSettings().mcp).toEqual({
    enabled: true,
    port: 40000,
    token: 'synthetic-mcp',
  });
});

it('places OneBot config in the API backup partition and accepts old backups without it', () => {
  const f = configFixture({ settings: {} });
  f.service.setSettings({ oneBot: { enabled: true, token: 'synthetic' } });
  const settings = f.service.getSettings();
  expect(snapshotWeqSettings(settings)).not.toHaveProperty('oneBot');
  const api = snapshotWeqApiSettings(settings);
  expect(api.oneBot).toEqual(settings.oneBot);
  expect(() => validateWeqApiSettings(api)).not.toThrow();
  const { oneBot: _oneBot, ...old } = api;
  expect(() => validateWeqApiSettings(old)).not.toThrow();
  expect(() => validateWeqApiSettings({ oneBot: { enabled: true, port: 0, token: '' } })).toThrow(
    'api.oneBot.port',
  );
});
