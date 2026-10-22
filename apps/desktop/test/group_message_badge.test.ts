import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  GroupMessageBadge,
  type GroupBadgeMember,
} from '../src/renderer/src/components/GroupMessageBadge';

const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
});
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.unstubAllGlobals();
});
function render(member: GroupBadgeMember) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(h(GroupMessageBadge, { member })));
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return host.querySelector<HTMLElement>('.member-badge');
}
describe('群消息头衔固定展示', () => {
  it('固定配色样式由共享组件加载，保留独立深色 token 并移除等级分档色', () => {
    const css = readFileSync(resolve('src/renderer/src/styles/group-message-badge.css'), 'utf8');
    expect(css).toContain("html[data-theme='dark'] .member-badge");
    for (const role of ['owner', 'admin', 'custom', 'neutral'])
      expect(css).toContain(`--weq-title-${role}-bg`);
    expect(css).not.toMatch(/\.level-\d/);
    if (!process.env.WEQ_GROUP_BADGE_QA_DIR) return;
    const cases: Array<[string, GroupBadgeMember]> = [
      ['群主的专属头衔', { role: 'owner', customTitle: '项目组长', memberLevel: 42 }],
      ['管理员的专属头衔', { role: 'admin', customTitle: '值班管理员', memberLevel: 27 }],
      ['普通成员的专属头衔', { customTitle: '热心同学', memberLevel: 10 }],
      ['普通成员的等级头衔', { levelName: '活跃成员', memberLevel: 8 }],
      ['群主没有专属头衔', { role: 'owner', levelName: '等级头衔' }],
      ['管理员没有专属头衔', { role: 'admin', levelName: '等级头衔' }],
      ['仅有数字等级', { memberLevel: 0 }],
      ['长专属头衔', { customTitle: '非常非常长的专属头衔用于检验手机窄屏显示边界和省略效果' }],
    ];
    const host = document.createElement('div'),
      root = createRoot(host);
    act(() =>
      root.render(
        h(
          'main',
          null,
          ...cases.map(([label, member]) =>
            h(
              'section',
              { key: label },
              h('span', { className: 'qa-label' }, label),
              h(
                'div',
                { className: 'qa-name' },
                h('span', null, '测试昵称'),
                h(GroupMessageBadge, { member }),
              ),
            ),
          ),
        ),
      ),
    );
    const html = `<!doctype html><html data-theme="light"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n*{box-sizing:border-box}body{margin:0;padding:20px;font-family:system-ui;color:#252830;background:#f6f7f9}html[data-theme=dark] body{color:#e5e8ee;background:#202226}main{width:min(680px,100%);margin:auto}section{padding:14px 0;border-bottom:1px solid #8885}.qa-label{display:block;font-size:12px;opacity:.7;margin-bottom:8px}.qa-name{display:flex;align-items:center;gap:6px;min-width:0;font-size:13px}.qa-name>span{flex-shrink:0}</style><body>${host.innerHTML}</body></html>`;
    act(() => root.unmount());
    mkdirSync(process.env.WEQ_GROUP_BADGE_QA_DIR, { recursive: true });
    writeFileSync(join(process.env.WEQ_GROUP_BADGE_QA_DIR, 'group-badges.html'), html);
  });
  it.each([
    [{ role: 'owner', customTitle: '专属头衔', levelName: '等级头衔' }, '专属头衔', 'owner'],
    [{ role: 'admin', customTitle: '专属头衔', levelName: '等级头衔' }, '专属头衔', 'admin'],
    [
      { role: 'member', customTitle: '专属头衔', levelName: '等级头衔' },
      '专属头衔',
      'custom-title',
    ],
    [{ role: 'owner', levelName: '等级头衔' }, '群主', 'owner'],
    [{ role: 'admin', levelName: '等级头衔' }, '管理员', 'admin'],
    [{ role: 'member', levelName: '等级头衔' }, '等级头衔', 'neutral'],
    [{ role: 'member', customTitle: '  ', levelName: '等级头衔' }, '等级头衔', 'neutral'],
    [{ role: 'unknown', customTitle: '自定义' }, '自定义', 'custom-title'],
  ] as const)('按专属、角色、等级优先级显示 %s', (member, label, tone) => {
    const badge = render(member);
    expect(badge?.textContent).toBe(label);
    expect(badge?.classList.contains(tone)).toBe(true);
  });
  it('数字等级保留，但不参与头衔优先级或配色', () => {
    const badge = render({
      role: 'owner',
      customTitle: '合成专属',
      levelName: '活跃',
      memberLevel: 42,
    });
    expect(badge?.textContent).toBe('Lv42 · 合成专属');
    expect(badge?.classList.contains('owner')).toBe(true);
    expect(badge?.className).not.toMatch(/level-\d/);
  });
  it('仅有数字等级用灰色，无可用文字或等级不渲染', () => {
    expect(render({ memberLevel: 42, levelName: 'Lv42' })?.textContent).toBe('Lv42');
    expect(render({ memberLevel: 0 })?.textContent).toBe('Lv0');
    expect(render({ memberLevel: 42 })?.classList.contains('neutral')).toBe(true);
    expect(render({})).toBeNull();
    expect(render({ memberLevel: Number.NaN })).toBeNull();
    expect(render({ memberLevel: -1 })).toBeNull();
  });
  it('旧的隐藏偏好不再影响显示，也不读写本地显示设置', () => {
    localStorage.setItem(
      'weq.group-badge-display.v1',
      '{"old":{"showTitle":false,"showLevel":false}}',
    );
    const read = vi.spyOn(Storage.prototype, 'getItem'),
      write = vi.spyOn(Storage.prototype, 'setItem');
    expect(render({ customTitle: '仍然显示', memberLevel: 8 })?.textContent).toBe('Lv8 · 仍然显示');
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    read.mockRestore();
    write.mockRestore();
  });
});
