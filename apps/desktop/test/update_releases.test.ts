// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { selectUpdateRelease } from '../src/main/update/releases';

const release = (tag_name: string, prerelease = false, draft = false) => ({
  tag_name,
  prerelease,
  draft,
  published_at: '2026-11-11T00:00:00Z',
  assets: [{ name: 'latest-mac.yml' }],
});
describe('正式版与测试版更新选择', () => {
  it('纯数字测试发布也受开关控制，不依赖 API 返回顺序', () => {
    const data = [
      release('v2.6.1'),
      release('v2.7.0', true),
      release('v3.0.0', false, true),
      release('v2.8.0-beta.1'),
    ];
    expect(selectUpdateRelease(data, false, 'latest-mac.yml').version).toBe('2.6.1');
    expect(selectUpdateRelease(data, true, 'latest-mac.yml').version).toBe('2.8.0-beta.1');
    expect(() => selectUpdateRelease([release('v2.7.0', true)], false, 'latest-mac.yml')).toThrow();
  });
  it('排除无发布时间或缺少本平台清单的发布', () => {
    expect(() =>
      selectUpdateRelease([{ ...release('v3.0.0'), published_at: null }], true, 'latest-mac.yml'),
    ).toThrow();
    expect(() => selectUpdateRelease([release('v3.0.0')], true, 'latest.yml')).toThrow();
  });
  it('支持 beta 清单，选择后固定到具体标签', () => {
    expect(
      selectUpdateRelease(
        [{ ...release('v3.0.0-beta.2', true), assets: [{ name: 'beta-mac.yml' }] }],
        true,
        'latest-mac.yml',
      ),
    ).toMatchObject({ tag: 'v3.0.0-beta.2', manifest: 'beta-mac.yml', channel: 'beta' });
  });
});
