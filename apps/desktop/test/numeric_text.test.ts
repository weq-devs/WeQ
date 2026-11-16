import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { NumericText } from '../src/renderer/src/components/NumericText';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  vi.unstubAllGlobals();
});

function render(text: string, svg = false) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const value = h(NumericText, { as: svg ? 'tspan' : 'span' }, text);
  act(() => root.render(svg ? h('svg', null, h('text', null, value)) : value));
  cleanup.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return host;
}

it('大小、百分比、时间和超长 seq 只改变数字字体，保留原始文本和精度', () => {
  const text =
    '已下载 1,234.50 MB / 2 GiB · 42% · 12:34:56 · seq 90071992547409931234–90071992547409931235';
  const host = render(text);
  expect(host.textContent).toBe(text);
  expect([...host.querySelectorAll('.weq-number')].map((node) => node.textContent)).toEqual([
    '1,234.50',
    '2',
    '42%',
    '12:34:56',
    '90071992547409931234–90071992547409931235',
  ]);
  expect(host.querySelectorAll('.weq-number-inherit')).toHaveLength(5);
});

it('无数字、空字符串和空白保持原样，文本不被当作 HTML', () => {
  for (const text of ['', '暂无可用数据', '  \n\t已完成 0012 <b>项</b>  ']) {
    const host = render(text);
    expect(host.textContent).toBe(text);
    expect(host.querySelector('b')).toBeNull();
    if (!/\d/.test(text)) expect(host.querySelector('.weq-number')).toBeNull();
  }
});

it('SVG 数字使用 tspan，不在图表文本中插入 HTML span', () => {
  const host = render('交集 12 / 34 个群', true);
  expect(host.querySelector('span')).toBeNull();
  expect(host.querySelectorAll('tspan')).toHaveLength(2);
  for (const node of host.querySelectorAll('tspan'))
    expect(node.namespaceURI).toBe('http://www.w3.org/2000/svg');
  expect(host.textContent).toBe('交集 12 / 34 个群');
});
