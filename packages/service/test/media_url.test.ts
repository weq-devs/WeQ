import { describe, expect, it } from 'vitest';
import { mediaNodeFromElement } from '../src/account/media_url';

describe('mediaNodeFromElement', () => {
  it('ptt 缺省 storeId 为 1，显式值优先', () => {
    expect(mediaNodeFromElement({ kind: 'ptt', fileToken: 'x' }).storeId).toBe(1);
    expect(mediaNodeFromElement({ kind: 'ptt', fileToken: 'x', storeId: 7 }).storeId).toBe(7);
  });
});
