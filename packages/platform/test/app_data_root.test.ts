import { join } from 'node:path';
import { expect, it } from 'vitest';
import { weqAppDataRoot } from '../src/app_data_root';

it('独立文件启动与三个平台工厂使用相同的目录约定', () => {
  expect(weqAppDataRoot('darwin', '/synthetic/home', {})).toBe(
    join('/synthetic/home', 'Library', 'Application Support', 'weq'),
  );
  expect(weqAppDataRoot('linux', '/synthetic/home', {})).toBe(
    join('/synthetic/home', '.config', 'weq'),
  );
  expect(weqAppDataRoot('linux', '/synthetic/home', { XDG_CONFIG_HOME: '/synthetic/xdg' })).toBe(
    join('/synthetic/xdg', 'weq'),
  );
  expect(weqAppDataRoot('win32', '/synthetic/home', { APPDATA: '/synthetic/appdata' })).toBe(
    join('/synthetic/appdata', 'weq'),
  );
  expect(() => weqAppDataRoot('win32', '/synthetic/home', {})).toThrow('APPDATA');
  expect(() => weqAppDataRoot('unsupported', '/synthetic/home', {})).toThrow('平台');
});
