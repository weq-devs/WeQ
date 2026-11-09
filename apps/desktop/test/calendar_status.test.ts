import { expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageCalendar } from '../src/renderer/src/components/MessageCalendar';

it('未完成的日历显示等待，不把未知计数称为零', () => {
  const html = renderToStaticMarkup(
    createElement(MessageCalendar, {
      month: '2026-11',
      days: [{ day: '2026-11-01', count: 0 }],
      dayStatus: { '2026-11-01': { complete: false } },
      statusText: '等待数据库空闲…',
      allowEmpty: true,
      onPick: () => {},
    }),
  );
  expect(html).toContain('等待数据库空闲…');
  expect(html).toContain('2026-11-01，消息数量统计中');
  expect(html).not.toContain('2026-11-01，0 条消息');
  expect(html).not.toContain('0 个有记录日期');
});

it('已确认的空日期才显示零', () => {
  const html = renderToStaticMarkup(
    createElement(MessageCalendar, {
      month: '2026-11',
      days: [{ day: '2026-11-01', count: 0 }],
      dayStatus: { '2026-11-01': { complete: true } },
      allowEmpty: true,
      onPick: () => {},
    }),
  );
  expect(html).toContain('2026-11-01，0 条消息');
});
it('未完成但已有部分计数时显示累计数字与加号，不冒称全部完成', () => {
  const html = renderToStaticMarkup(
    createElement(MessageCalendar, {
      month: '2026-11',
      days: [{ day: '2026-11-01', count: 42 }],
      dayStatus: { '2026-11-01': { complete: false } },
      allowEmpty: true,
      onPick: () => {},
    }),
  );
  expect(html).toContain('42+');
  expect(html).toContain('已计 42 条，尚未完成');
});
