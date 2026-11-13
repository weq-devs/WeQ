import { describe, expect, it } from 'vitest';
import { parseQzoneLikesResult } from '../src/account/web/qzone_interaction';

const fixture = (likedata?: unknown) =>
  JSON.stringify({ code: 0, data: [{ current: { likedata } }] });

describe('structured Qzone likes coverage', () => {
  it.each([0, 1])('本人点赞标记 %s 独立于名单完整性', (ilike) => {
    expect(
      parseQzoneLikesResult(fixture({ cnt: 47, ilike, list: [[10002, 'other', 0]] })),
    ).toMatchObject({ selfLiked: ilike === 1, coverage: 'observed', reportedTotal: 47 });
  });
  it('没有名单时仍保留明确的本人点赞标记', () => {
    expect(parseQzoneLikesResult(fixture({ cnt: 47, ilike: 1 }))).toMatchObject({
      selfLiked: true,
      likes: [],
      coverage: 'unobserved',
    });
  });
  it.each([undefined, null, -1, 2, '1', true])('不猜测非法本人标记 %s', (ilike) => {
    expect(parseQzoneLikesResult(fixture({ cnt: 0, ilike }))).toMatchObject({ selfLiked: null });
  });
  it('没有成功业务码时不接受本人点赞标记', () => {
    expect(
      parseQzoneLikesResult(JSON.stringify({ data: [{ current: { likedata: { ilike: 1 } } }] })),
    ).toMatchObject({ selfLiked: null });
  });
  it('verifies the reported count against unique valid accounts', () => {
    expect(
      parseQzoneLikesResult(
        fixture({
          cnt: 2,
          list: [
            [10001, 'one'],
            [10002, 'two'],
          ],
        }),
      ),
    ).toMatchObject({ reportedTotal: 2, coverage: 'complete', reason: 'matched-count' });
  });
  it('does not promote a truncated or duplicate list to complete', () => {
    const result = parseQzoneLikesResult(
      fixture({
        cnt: 3,
        list: [
          [10001, 'one'],
          [10001, 'duplicate'],
          [0, 'placeholder'],
        ],
      }),
    );
    expect(result.likes).toHaveLength(1);
    expect(result).toMatchObject({
      reportedTotal: 3,
      coverage: 'observed',
      reason: 'count-mismatch',
    });
  });
  it('separates explicit zero from missing response data and missing totals', () => {
    expect(parseQzoneLikesResult(fixture({ cnt: 0 }))).toMatchObject({
      coverage: 'complete',
      reportedTotal: 0,
    });
    expect(parseQzoneLikesResult(fixture())).toMatchObject({
      coverage: 'unobserved',
      reportedTotal: null,
    });
    expect(parseQzoneLikesResult(fixture({ list: [] }))).toMatchObject({
      coverage: 'observed',
      reportedTotal: null,
      reason: 'missing-count',
    });
    expect(parseQzoneLikesResult(fixture({ cnt: 10 }))).toMatchObject({
      coverage: 'unobserved',
      reportedTotal: 10,
    });
  });
  it('does not accept a service rejection as an empty authoritative list', () => {
    expect(() => parseQzoneLikesResult(JSON.stringify({ code: -3000 }))).toThrow();
  });
  it('does not claim complete membership without an explicit accepted response', () => {
    const result = parseQzoneLikesResult(
      JSON.stringify({ data: [{ current: { likedata: { cnt: 0, list: [] } } }] }),
    );
    expect(result).toMatchObject({ coverage: 'observed', reason: 'unverified-response' });
  });
  it('does not count malformed string entries as accounts', () => {
    expect(parseQzoneLikesResult(fixture({ cnt: 1, list: ['10001'] }))).toMatchObject({
      likes: [],
      coverage: 'observed',
      reason: 'count-mismatch',
    });
  });
});
