import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import {
  ProfileCacheFields,
  SignatureUpdated,
} from '../src/renderer/src/components/ProfileCacheFields';
import { groupFriends, sortFriends } from '../src/renderer/src/lib/contactListOrder';
import { friendSortDetail } from '../src/renderer/src/lib/contactDirectoryPresentation';
import { contactCacheFields } from '../src/renderer/src/lib/contactCachePolicy';
import type { Contact } from '../src/renderer/src/im-template/template/types';

afterEach(() => vi.unstubAllGlobals());
const ext = {
  occupation: 13,
  bloodType: 5,
  zodiac: 1,
  interactMarks: [],
  privileges: [],
  interests: [],
  album: [],
};
const contact = (id: string, sigUpdateTime?: number): Contact => ({
  id,
  identityLabel: 'QQ',
  identityValue: '10001',
  username: id,
  displayName: id,
  createdAt: '',
  avatarUrl: null,
  sigUpdateTime,
  extInfo: ext,
});
const seconds = Date.parse('2026-11-10T16:01:02Z') / 1000;

it('签名时间正反序均未知沉底，默认并列稳定，不走在线指标', () => {
  const rows = [
    contact('unknown'),
    contact('b', seconds),
    contact('a', seconds),
    contact('new', seconds + 1),
    contact('invalid', seconds * 1000),
  ];
  expect(sortFriends(rows, 'sigUpdateTime', true, {}).map((row) => row.id)).toEqual([
    'new',
    'a',
    'b',
    'invalid',
    'unknown',
  ]);
  expect(sortFriends(rows, 'sigUpdateTime', false, {}).map((row) => row.id)).toEqual([
    'a',
    'b',
    'new',
    'invalid',
    'unknown',
  ]);
  expect(contactCacheFields('sort', 'sigUpdateTime')).toEqual([]);
  expect(friendSortDetail(rows[1]!, 'sigUpdateTime', {})?.text).toContain('2026-11-11 00:01:02');
  expect(
    groupFriends([contact('a'), { ...contact('b'), extInfo: null }], 'occupation', {}).map(
      (group) => group.name,
    ),
  ).toEqual(['学生', '职业未知']);
});

it('好友和群友共用缓存资料行，签名时间不脱离签名显示', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div'),
    root = createRoot(host);
  try {
    act(() => root.render(h(ProfileCacheFields, { extInfo: ext })));
    expect(host.textContent).toContain('学生');
    expect(host.textContent).toContain('其他');
    expect(host.textContent).not.toContain('编号');
    act(() =>
      root.render(h(ProfileCacheFields, { extInfo: { ...ext, occupation: 900, bloodType: 900 } })),
    );
    expect(host.textContent).toContain('职业（编号 900）');
    expect(host.textContent).toContain('血型（编号 900）');
    expect(host.textContent).toContain('鼠');
    act(() => root.render(h(SignatureUpdated, { signature: '', sigUpdateTime: seconds })));
    expect(host.textContent).toBe('');
    act(() => root.render(h(SignatureUpdated, { signature: '本地签名', sigUpdateTime: seconds })));
    expect(host.textContent).toContain('2026-11-11 00:01:02');
    act(() =>
      root.render(h(SignatureUpdated, { signature: '本地签名', sigUpdateTime: seconds * 1000 })),
    );
    expect(host.textContent).toBe('');
  } finally {
    act(() => root.unmount());
  }
});
