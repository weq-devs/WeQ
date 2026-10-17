import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  MessageProvenance,
  ShowMessageSeqContext,
  ShowMessageTimeContext,
} from '../src/renderer/src/components/MessageProvenance';
import {
  beijingDay,
  daySeconds,
  messageDensity,
  pickCalendarRange,
} from '../src/renderer/src/lib/messageCalendar';
import { visibleListRange, WindowedList } from '../src/renderer/src/components/WindowedList';

function metadata(seq: boolean, time: boolean, system = false) {
  return renderToStaticMarkup(
    createElement(
      ShowMessageSeqContext.Provider,
      { value: seq },
      createElement(
        ShowMessageTimeContext.Provider,
        { value: time },
        createElement(MessageProvenance, {
          system,
          message: { msgSeq: '42', createdAt: '2026-10-16T17:02:03Z' },
        }),
      ),
    ),
  );
}

describe('消息元信息', () => {
  it('序号与精确到秒的时间分别设置，系统灰条不显示序号', () => {
    expect(metadata(false, false)).toBe('');
    expect(metadata(true, false)).toContain('seq 42');
    expect(metadata(true, false)).not.toContain('<time');
    expect(metadata(false, true)).toContain('01:02:03');
    expect(metadata(false, true)).not.toContain('seq 42');
    expect(metadata(true, true, true)).toContain('01:02:03');
    expect(metadata(true, true, true)).not.toContain('seq 42');
  });
});

describe('共用聊天日历', () => {
  it('使用北京时间的跨日边界，不依赖主机时区', () => {
    expect(beijingDay(new Date('2026-10-16T17:02:03Z'))).toBe('2026-10-17');
    expect(daySeconds('2026-10-17')).toBe(Date.parse('2026-10-16T16:00:00Z') / 1000);
  });
  it('密度按消息数单调分成七级，空日不着色', () => {
    expect(messageDensity(0, 10000)).toBe(0);
    const levels = [1, 10, 100, 1000, 10000].map((n) => messageDensity(n, 10000));
    expect(levels).toEqual([...levels].sort((a, b) => a - b));
    expect(levels.at(-1)).toBe(7);
    expect(new Set(levels).size).toBeGreaterThan(3);
  });
  it('范围支持正选、反选、同一天、重选与不限', () => {
    expect(pickCalendarRange('', '', '2026-10-17')).toEqual({ start: '2026-10-17', end: '' });
    expect(pickCalendarRange('2026-10-17', '', '2026-10-15')).toEqual({
      start: '2026-10-15',
      end: '2026-10-17',
    });
    expect(pickCalendarRange('2026-10-17', '', '2026-10-17').end).toBe('2026-10-17');
    expect(pickCalendarRange('2026-10-15', '2026-10-17', '2026-10-20').end).toBe('');
  });
});

describe('会话列表窗口', () => {
  it('一万会话只渲染可视区域，滚动可到末尾', () => {
    const items = Array.from({ length: 10000 }, (_, i) => `会话 ${i}`);
    const html = renderToStaticMarkup(
      createElement(WindowedList<string>, {
        items,
        rowHeight: 64,
        height: 480,
        itemKey: (item) => item,
        renderItem: (item) => createElement('button', null, item),
      }),
    );
    expect((html.match(/<button/g) ?? []).length).toBeLessThan(30);
    expect(visibleListRange(10000, 64, 480, 640000 - 480).end).toBe(10000);
    expect(visibleListRange(0, 64, 480, 999999)).toEqual({ start: 0, end: 0 });
  });
});
