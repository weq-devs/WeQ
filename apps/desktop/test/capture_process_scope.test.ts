// @vitest-environment node
import { expect, it } from 'vitest';
import { requireCaptureProcessScope } from '../src/main/capture_process_scope';

it.each([149, 258])('macOS PKTAP linktype=%s 可保持持续自动识别且有进程归属', (linktype) => {
  expect(() => requireCaptureProcessScope('darwin', linktype)).not.toThrow();
});
it.each([undefined, '', 'auto', '0', 'auto,443', ' AUTO '])(
  '旧组件的自动端口 %s 不冒称目标进程抓包',
  (port) => {
    expect(() => requireCaptureProcessScope('darwin', 1, port)).toThrow('修复长期授权');
  },
);
it('固定端口诊断和其他平台不被 macOS PKTAP 判断拦截', () => {
  expect(() => requireCaptureProcessScope('darwin', 1, '14000')).not.toThrow();
  expect(() => requireCaptureProcessScope('darwin', 1, '14000, ')).not.toThrow();
  for (const platform of ['linux', 'win32'])
    expect(() => requireCaptureProcessScope(platform, 1)).not.toThrow();
});
