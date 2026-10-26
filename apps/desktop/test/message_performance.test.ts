import { afterEach, expect, it } from 'vitest';
import {
  installMessagePerformanceProbe,
  messagePerformanceSnapshot,
  recordMessagePhase,
  measureMessagePhase,
} from '../src/renderer/src/lib/messagePerformance';
afterEach(() => {
  document.body.innerHTML = '';
});

it('切换来源后不把旧查询的迟到耗时写入新来源采样', async () => {
  const first = installMessagePerformanceProbe();
  let finish!: () => void;
  const pending = measureMessagePhase(
    'windowQuery',
    () =>
      new Promise<void>((done) => {
        finish = done;
      }),
  );
  first();
  const second = installMessagePerformanceProbe();
  try {
    finish();
    await pending;
    expect(messagePerformanceSnapshot().phases.windowQuery.count).toBe(0);
  } finally {
    second();
  }
});

it('采样总数保留，分布窗口有界，未知阶段和业务原文不进入诊断快照', () => {
  const release = installMessagePerformanceProbe();
  try {
    for (let i = 0; i < 1000; i++) recordMessagePhase('windowQuery', i);
    recordMessagePhase('windowQuery', Number.NaN);
    const value = messagePerformanceSnapshot().phases.windowQuery;
    expect(value.count).toBe(1000);
    expect(value.samples).toBe(256);
    expect(value.p95Ms).toBe(987);
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div class="weq-readonly-chat"><div class="weq-virtual-timeline" data-total-items="3000"><div data-message-id="secret-uid" class="weq-virtual-timeline-row">private body</div></div></div>',
    );
    document.dispatchEvent(new Event('weq:message-performance-request'));
    const data = document.getElementById('weq-message-performance')!.textContent!;
    expect(data).not.toContain('secret-uid');
    expect(data).not.toContain('private body');
    expect(JSON.parse(data).dom).toEqual({ messageRows: 1, virtualRows: 1, logicalRows: 3000 });
  } finally {
    release();
  }
  expect(document.getElementById('weq-message-performance')).toBeNull();
});
