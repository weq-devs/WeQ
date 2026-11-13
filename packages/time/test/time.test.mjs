import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import {
  formatDateTime,
  formatUnixTime,
  formatDate,
  formatChatTime,
  formatConversationTime,
  formatRelativeTime,
  formatTimeRange,
  formatDuration,
  formatChineseDate,
  formatDateTimeInput,
  parseDateTimeInput,
  calendarStart,
  browserTimeSource,
  calendarDayWindow,
} from '../src/index.mjs';

describe('功能时间格式与真实精度', () => {
  const sample = '2026-03-04T06:05:06.789Z';
  it('业务日窗口以北京日界计算，拒绝无效日而非自动进位', () => {
    const now = '2025-12-31T16:01:00Z';
    const expected = {
      startSec: Date.parse('2026-01-01T00:00:00+08:00') / 1000,
      endSec: Date.parse('2026-01-02T00:00:00+08:00') / 1000,
      label: '2026-01-01',
    };
    assert.deepEqual(calendarDayWindow(undefined, now), expected);
    assert.deepEqual(calendarDayWindow('  ', now), expected);
    assert.deepEqual(calendarDayWindow('2026-1-1', now), expected);
    assert.equal(calendarDayWindow('2026-02-30', now), null);
  });
  it('秒、毫秒和粗精度不互相伪造', () => {
    assert.equal(formatDateTime(sample), '2026-03-04 14:05:06');
    assert.equal(formatDateTime(sample, 'millisecond'), '2026-03-04 14:05:06.789');
    assert.equal(formatDateTime(sample, 'minute'), '2026-03-04 14:05');
    assert.equal(formatDateTime('2026-03-04'), '2026-03-04');
    assert.equal(formatDateTime('2026-03-04T14:05+08:00'), '2026-03-04 14:05');
    assert.equal(formatDateTime('2026-02-30T14:05:06Z'), '');
    assert.equal(formatUnixTime(1772604300), '2026-03-04 14:05:00');
    assert.equal(formatDateTime('2026-03-04T06:05:00.000Z'), '2026-03-04 14:05:00');
    assert.equal(
      formatDateTime(sample.replace('.789', '.000'), 'millisecond'),
      '2026-03-04 14:05:06.000',
    );
    for (const value of [null, undefined, '', 'bad', NaN, Infinity, '2026-02-30'])
      assert.equal(formatDateTime(value), '');
    assert.equal(formatDate(0), '1970-01-01');
  });
  it('宿主时区和夏令时不影响显示，内嵌页面与模块同源', () => {
    for (const TZ of ['Asia/Shanghai', 'UTC', 'America/New_York']) {
      const code = `import {formatDateTime,formatChatTime} from ${JSON.stringify(new URL('../src/index.mjs', import.meta.url).href)}; console.log(JSON.stringify([formatDateTime('2026-03-08T06:59:59Z'),formatChatTime('2025-12-31T23:59:59+08:00','2026-01-01T00:01:00+08:00')]));`;
      assert.deepEqual(
        JSON.parse(
          execFileSync(process.execPath, ['--input-type=module', '-e', code], {
            env: { ...process.env, TZ },
            encoding: 'utf8',
          }),
        ),
        ['2026-03-08 14:59:59', '昨天 23:59:59'],
      );
    }
    assert.equal(
      runInNewContext(
        `${browserTimeSource}\nformatDateTime('2026-03-04T06:05:06.789Z','millisecond')`,
      ),
      '2026-03-04 14:05:06.789',
    );
  });
  it('北京自然日、星期、跨年与未来', () => {
    const now = '2026-01-01T00:30:00+08:00';
    assert.equal(formatChatTime('2025-12-31T23:59:06+08:00', now), '昨天 23:59:06');
    assert.equal(formatChatTime('2026-01-02T00:00:00+08:00', now), '2026-01-02 00:00:00');
    assert.equal(formatConversationTime('2026-01-02T00:00:00+08:00', now), '2026-01-02');
    assert.equal(formatChatTime('2025-12-30T15:00:09Z', now), '星期二 23:00:09');
    assert.equal(formatChineseDate(sample, false), '3月4日');
    assert.equal(formatRelativeTime('2026-01-01T00:32:00+08:00', now), '2 分钟后');
    assert.equal(
      formatTimeRange('2025-12-31T23:59:06+08:00', now, now),
      '2025-12-31 23:59:06 — 2026-01-01 00:30:00',
    );
  });
  it('输入按北京往返并拒绝无效日历进位', () => {
    assert.equal(formatDateTimeInput(sample), '2026-03-04T14:05:06');
    assert.equal(
      parseDateTimeInput('2024-02-29T23:59:59'),
      Date.parse('2024-02-29T23:59:59+08:00'),
    );
    for (const value of [
      '2026-02-30T12:00',
      '2026-02-29T12:00',
      '2026-13-01T00:00',
      '2026-01-01T24:00',
      '2026-01-01T12:60',
      '2026-01-01T12:00:60',
    ])
      assert.equal(parseDateTimeInput(value), null);
    assert.equal(formatDate(calendarStart(2026, 3, 0)), '2026-02-28');
  });
  it('时长先舍入再进位，不生成分60秒', () => {
    assert.equal(formatDuration(119.9, 'approximate'), '2分');
    assert.equal(formatDuration(3599.9, 'countdown'), '01:00:00');
    assert.equal(formatDuration(3601, 'media'), '60:01');
    assert.equal(formatDuration(9, 'call'), '00:09');
    assert.equal(formatDuration(90061), '1天1小时1分1秒');
    assert.equal(formatDuration(0.123, 'elapsed'), '123 ms');
    assert.equal(formatDuration(1.234, 'elapsed'), '1.234 s');
    assert.equal(formatDuration(0.000123, 'elapsed'), '0.123 ms');
    assert.equal(formatDuration(-1), '');
  });
});
