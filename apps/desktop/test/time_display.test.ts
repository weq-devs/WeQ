import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { TimeLabel, DurationLabel } from '../src/renderer/src/components/TimeLabel';
import { groupCreationDate } from '../src/renderer/src/components/groupProfile/GroupContent';
import { formatExpiry } from '../src/renderer/src/components/settings/AccountBasicsSection';
import { formatCacheExpiry } from '../src/renderer/src/components/settings/ExternalRkeySection';
import { MessageTimeDivider } from '../src/renderer/src/im-template/template/messageTime';
import { ChatTimeDivider } from '../src/renderer/src/views/agentlab/messageTime';
import { formatFileTime } from '../src/renderer/src/lib/groupFile';
import { formatMailTime } from '../src/renderer/src/views/mail/content';
import {
  formatSignupDeadline,
  resolveSignupDeadline,
} from '../src/renderer/src/im-template/template/arkCards';
import {
  nodeTimeValue,
  parseNodeTime,
} from '../src/renderer/src/components/mergeForward/NodeTimeInput';

afterEach(() => vi.useRealTimers());

describe('功能接入统一格式', () => {
  it('文件、邮件和报名截止均显示北京时间秒，非法日期被拒绝', () => {
    const seconds = Date.parse('2026-03-04T06:05:06Z') / 1000;
    for (const text of [
      formatFileTime(seconds),
      formatMailTime(seconds),
      formatSignupDeadline(seconds),
    ]) {
      expect(text).toBe('2026-03-04 14:05:06');
    }
    expect(resolveSignupDeadline('2026-02-30 12:00:00').ok).toBe(false);
    expect(nodeTimeValue(seconds)).toBe('2026-03-04T14:05:06');
    expect(parseNodeTime('2026-02-30T12:00:00')).toBeNull();
    expect(groupCreationDate('0')).toBe('');
    expect(groupCreationDate('2026-03-04')).toBe('2026-03-04');
    expect(groupCreationDate('2026-03-04T06:05:06Z')).toBe('2026-03-04 14:05:06');
  });
  it('普通与助手消息分隔同规则，完整提示不把秒级 ISO 当成毫秒来源', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-04T15:00:00+08:00'));
    const iso = '2026-03-04T06:05:06.000Z';
    const normal = renderToStaticMarkup(createElement(MessageTimeDivider, { value: iso }));
    const assistant = renderToStaticMarkup(createElement(ChatTimeDivider, { ts: Date.parse(iso) }));
    expect(normal).toContain('14:05:06');
    expect(normal).toContain('title="2026-03-04 14:05:06（北京时间）"');
    expect(assistant).toContain('title="2026-03-04 14:05:06.000（北京时间）"');
    expect(
      renderToStaticMarkup(
        createElement(MessageTimeDivider, { value: iso, precision: 'millisecond' }),
      ),
    ).toContain('title="2026-03-04 14:05:06.000（北京时间）"');
    expect(normal).toContain('tabindex="0"');
  });
  it('毫秒详情保留精度，缺失值不产生 1970 年占位', () => {
    expect(
      renderToStaticMarkup(
        createElement(TimeLabel, { value: '2026-03-04T06:05:06.789Z', precision: 'millisecond' }),
      ),
    ).toContain('2026-03-04 14:05:06.789');
    expect(renderToStaticMarkup(createElement(TimeLabel, { value: null }))).toBe('');
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(createElement(TimeLabel, { value: '2026-03-04' }));
    expect(host.querySelector('time')?.getAttribute('datetime')).toBe('2026-03-04');
    expect(renderToStaticMarkup(createElement(DurationLabel, { seconds: 0.25 }))).toContain(
      'title="0.25秒"',
    );
  });
  it('到期时刻显示完整日期，缺失的签发时间或到期时间不伪造 epoch', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-04T15:00:00+08:00'));
    const issued = Date.parse('2026-03-04T14:05:06+08:00') / 1000;
    expect(formatExpiry(issued, 7200).text).toContain('2026-03-04 16:05:06');
    expect(formatExpiry(issued, 7200).expired).toBe(false);
    expect(formatExpiry(0, 7200)).toEqual({ text: '到期时间未知', expired: true });
    expect(formatCacheExpiry(undefined)).toEqual({ text: '尚未拉取 rkey', expired: false });
    expect(formatCacheExpiry(0).text).not.toContain('1970');
    expect(formatCacheExpiry(0).expired).toBe(true);
  });
});
