import { describe, expect, it } from 'vitest';
import {
  mergeRoamingTimeline,
  mergeRoamingWindow,
  timelineSeq,
  timelineRowKey,
  type TimelineRow,
} from '../src/shared/roaming_timeline';

const row = (seq: number, extra: Partial<TimelineRow> = {}): TimelineRow => ({
  msgId: `message-${seq}`,
  msgSeq: String(seq),
  ...extra,
});

describe('roaming timeline projection', () => {
  it('pushes batches into a detached loaded window without extending its bounds', () => {
    const loaded = [row(100), row(200)];
    expect(
      mergeRoamingWindow('group', loaded, [row(10), row(150), row(300)]).map((r) => r.msgSeq),
    ).toEqual(['100', '150', '200']);
    expect(mergeRoamingWindow('group', loaded, [row(10), row(300)])).toBe(loaded);
  });
  it('does not inject an unanchored batch into an empty or seq-less window', () => {
    const loaded = [row(0)];
    expect(mergeRoamingWindow('group', loaded, [row(1)])).toBe(loaded);
    expect(mergeRoamingWindow('group', [], [row(1)])).toEqual([]);
  });
  it('keeps server randoms separate from local IDs and keys repeated randoms by seq', () => {
    const merged = mergeRoamingTimeline(
      'group',
      [row(1, { msgId: '0' })],
      [row(2, { msgId: '0' }), row(3, { msgId: '0' })],
    );
    expect(merged.map(timelineRowKey)).toEqual(['0', 'roaming:2:0', 'roaming:3:0']);
  });
  it('fills group gaps with a source marker without mutating source rows', () => {
    const cached = row(2);
    expect(mergeRoamingTimeline('group', [row(1), row(3)], [cached])).toEqual([
      row(1),
      row(2, { source: 'roaming' }),
      row(3),
    ]);
    expect(cached.source).toBeUndefined();
  });
  it('prefers all local rows, preserving gray tips that share a sequence', () => {
    const local = [row(2), row(2, { msgId: 'gray-tip' })];
    expect(mergeRoamingTimeline('group', local, [row(2, { msgId: 'remote-random' })])).toEqual(
      local,
    );
  });
  it('does not mix legacy C2C numbering with confirmed NT sequences', () => {
    expect(
      mergeRoamingTimeline('c2c', [row(1)], [row(2), row(3, { ntSeqVerified: true })]),
    ).toEqual([row(1), row(3, { ntSeqVerified: true, source: 'roaming' })]);
  });
  it('replaces a previous roaming row when QQ later syncs the local row', () => {
    expect(
      mergeRoamingTimeline(
        'group',
        [row(2, { source: 'roaming' }), row(2, { msgId: 'local' })],
        [],
      ),
    ).toEqual([row(2, { msgId: 'local' })]);
  });
  it('supports descending latest/before/from and ascending after pages with exact boundaries', () => {
    const cache = [row(1), row(2), row(4), row(5)];
    expect(
      mergeRoamingTimeline('group', [row(3)], cache, { descending: true, limit: 3, max: 4n }).map(
        (r) => r.msgSeq,
      ),
    ).toEqual(['4', '3', '2']);
    expect(
      mergeRoamingTimeline('group', [row(3)], cache, { limit: 3, min: 2n }).map((r) => r.msgSeq),
    ).toEqual(['2', '3', '4']);
    expect(
      mergeRoamingTimeline('group', [], cache, { limit: 2, descending: true }).map((r) => r.msgSeq),
    ).toEqual(['5', '4']);
  });
  it('keeps earlier inserted roaming rows when another gap is filled', () => {
    const first = mergeRoamingTimeline('group', [row(1), row(3), row(5)], [row(2)]);
    expect(mergeRoamingTimeline('group', first, [row(4), row(4)]).map((r) => r.msgSeq)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
    ]);
  });
  it('uses bigint ordering and skips invalid roaming cursors', () => {
    expect(timelineSeq('bad')).toBeNull();
    expect(timelineSeq('0')).toBeNull();
    expect(
      mergeRoamingTimeline(
        'group',
        [],
        [
          row(0),
          row(1, { msgSeq: 'bad' }),
          row(2, { msgSeq: '9007199254740993' }),
          row(3, { msgSeq: '9007199254740992' }),
        ],
      ).map((r) => r.msgSeq),
    ).toEqual(['9007199254740992', '9007199254740993']);
  });
});
