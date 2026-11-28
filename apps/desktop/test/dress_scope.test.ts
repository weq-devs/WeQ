import { afterEach, expect, it } from 'vitest';
import {
  applyDressSkin,
  fontRules,
  localDressApplies,
  type DressScope,
} from '../src/renderer/src/lib/dressSkin';

afterEach(() => applyDressSkin(null, null, null));

it.each([
  ['mine', true, true, true],
  ['mine', true, false, true],
  ['mine', false, true, false],
  ['mine', false, false, false],
  ['fallback', true, true, false],
  ['fallback', true, false, true],
  ['fallback', false, true, false],
  ['fallback', false, false, true],
  ['all', true, true, true],
  ['all', true, false, true],
  ['all', false, true, true],
  ['all', false, false, true],
] as const)('范围 %s / 自己 %s / 有原装扮 %s → %s', (scope, mine, original, expected) => {
  expect(localDressApplies(scope, mine, original)).toBe(expected);
});

it.each(['mine', 'fallback', 'all'] as const)(
  '范围 %s 的 CSS 按原始装扮而非加载结果匹配，气泡与字体独立',
  (scope: DressScope) => {
    const host = document.createElement('div');
    host.innerHTML = ['mine', 'theirs']
      .flatMap((side) => [
        `<div class="message-line ${side}" data-case="${side}-plain"><div class="message-content"></div></div>`,
        `<div class="message-line ${side}" data-case="${side}-bubble" data-record-bubble="11"><div class="message-content"></div></div>`,
        `<div class="message-line ${side}" data-case="${side}-font" data-record-font="22"><div class="message-content"></div></div>`,
      ])
      .join('');
    applyDressSkin(
      {
        itemId: 11,
        slice: { left: 4, right: 4, top: 4, bottom: 4 },
        imageSize: { w: 40, h: 40 },
        textColor: '#222222',
      },
      null,
      null,
      scope,
    );
    const style = document.getElementById('weq-dress-skin') as HTMLStyleElement;
    const bubbleRule = Array.from(style.sheet!.cssRules).find((rule) =>
      rule.cssText.includes('border-image-source:'),
    ) as CSSStyleRule;
    const bubbleCases = Array.from(
      host.querySelectorAll(bubbleRule.selectorText),
      (node) => node.parentElement!.dataset.case,
    );
    const fontSelector = fontRules(
      { itemId: 22, fontUrl: '', deriveVersion: 1, fx: null },
      scope,
    ).split(' {')[0]!;
    const fontCases = Array.from(
      host.querySelectorAll(fontSelector),
      (node) => node.parentElement!.dataset.case,
    );
    if (scope === 'mine') {
      expect(bubbleCases).toEqual(['mine-plain', 'mine-bubble', 'mine-font']);
      expect(fontCases).toEqual(bubbleCases);
    } else if (scope === 'fallback') {
      expect(bubbleCases).toEqual(['mine-plain', 'mine-font', 'theirs-plain', 'theirs-font']);
      expect(fontCases).toEqual(['mine-plain', 'mine-bubble', 'theirs-plain', 'theirs-bubble']);
      expect(style.textContent).toContain('.message-line.theirs:not([data-record-bubble])');
    } else {
      expect(bubbleCases).toHaveLength(6);
      expect(fontCases).toEqual(bubbleCases);
    }
  },
);

it('只替换自己发出的转发记录，并按左侧气泡绘制', () => {
  const host = document.createElement('div');
  host.innerHTML = [
    '<div class="message-line theirs" data-case="peer"><div class="message-content"></div></div>',
    '<div class="message-line theirs" data-weq-dress-mine data-case="self"><div class="message-content"></div></div>',
  ].join('');
  applyDressSkin(
    {
      itemId: 11,
      slice: { left: 4, right: 4, top: 4, bottom: 4 },
      imageSize: { w: 40, h: 40 },
      textColor: '#222222',
    },
    null,
    null,
    'mine',
  );
  const style = document.getElementById('weq-dress-skin') as HTMLStyleElement;
  const baseRule = Array.from(style.sheet!.cssRules).find((rule) =>
    rule.cssText.includes('border-image-source:'),
  ) as CSSStyleRule;
  const bubbleCases = Array.from(
    host.querySelectorAll(baseRule.selectorText),
    (node) => node.parentElement!.dataset.case,
  );
  const fontSelector = fontRules(
    { itemId: 22, fontUrl: '', deriveVersion: 1, fx: null },
    'mine',
  ).split(' {')[0]!;
  expect(bubbleCases).toEqual(['self']);
  expect(host.querySelector(fontSelector)?.parentElement?.dataset.case).toBe('self');
  expect(style.textContent).toContain('.message-line.theirs[data-weq-dress-mine]');
});
