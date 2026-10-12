import { describe, expect, it } from 'vitest';
import { parseQzoneLikesResult } from '../src/account/web/qzone_interaction';

const fixture = (likedata?: unknown) =>
  JSON.stringify({ code: 0, data: [{ current: { likedata } }] });

describe('structured Qzone likes coverage', () => {
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
