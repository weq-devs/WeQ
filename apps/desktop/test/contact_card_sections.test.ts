import { describe, expect, it } from 'vitest';
import { CONTACT_CARD_FIELDS, DEFAULT_CONTACT_CARD } from '@weq/service/contact-card';
import {
  CONTACT_CARD_SECTIONS,
  contactCardFieldGroup,
  moveContactCardSectionField,
} from '../src/renderer/src/lib/contactCardSections';

describe('名片设置分区', () => {
  it('每个可配置字段恰好归入一个可见分区', () => {
    const groups = new Set<string>(CONTACT_CARD_SECTIONS.map(({ key }) => key));
    for (const [field] of CONTACT_CARD_FIELDS)
      expect(groups.has(contactCardFieldGroup(field))).toBe(true);
  });

  it('按名片实际位置归类身份、展示及账号资料', () => {
    expect(contactCardFieldGroup('category')).toBe('identity');
    expect(contactCardFieldGroup('signatureUpdated')).toBe('identity');
    expect(contactCardFieldGroup('uid')).toBe('identity');
    expect(contactCardFieldGroup('company')).toBe('basic');
    expect(contactCardFieldGroup('common')).toBe('social');
    expect(contactCardFieldGroup('photos')).toBe('display');
    expect(contactCardFieldGroup('likes')).toBe('account');
    expect(contactCardFieldGroup('botFeatures')).toBe('bot');
  });

  it('同分区跨过交错字段排序，不移动其他分区的槽位', () => {
    const order = ['gender', 'qid', 'age', 'level', 'birthday'] as const;
    expect(moveContactCardSectionField([...order], 'birthday', -2)).toEqual([
      'birthday',
      'qid',
      'gender',
      'level',
      'age',
    ]);
    expect(moveContactCardSectionField([...order], 'gender', 1)).toEqual([
      'age',
      'qid',
      'gender',
      'level',
      'birthday',
    ]);
  });

  it('首尾移动不越过分区，未保存的字段不改变配置', () => {
    const order = [...DEFAULT_CONTACT_CARD.order];
    expect(moveContactCardSectionField(order, 'gender', -1)).toBe(order);
    expect(moveContactCardSectionField(order, 'email', 1)).toBe(order);
    expect(moveContactCardSectionField(['age'], 'birthday', 1)).toEqual(['age']);
  });
});
