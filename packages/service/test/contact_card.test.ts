import { describe, expect, it, vi } from 'vitest';
import {
  CONTACT_CARD_FIELDS,
  DEFAULT_CONTACT_CARD,
  normalizeContactCard,
  moveContactCardField,
} from '../src/common/contact_card';
import { PeerStatsService } from '../src/account/peer_stats';
import type { AccountSession } from '@weq/account';
import { DEFAULT_APP_SETTINGS } from '../src/bootstrap/user_config';
import { snapshotWeqSettings, validateWeqAppSettings } from '../src/bootstrap/backup_settings';
import { configFixture } from './support/user_config';

describe('联系人名片偏好', () => {
  it('持久化及重开保留布局，局部补丁不重置其他选择', () => {
    const fixture = configFixture();
    fixture.service.setSettings({
      contactCard: { visible: { company: false }, order: ['energy'] },
    });
    fixture.service.setSettings({ contactCard: { visible: { energy: true } } });
    const saved = fixture.open().getSettings().contactCard;
    expect(saved.visible.company).toBe(false);
    expect(saved.visible.energy).toBe(true);
    expect(saved.order[0]).toBe('energy');
  });
  it('同一份全局配置进入现有备份且可恢复', () => {
    const contactCard = normalizeContactCard({ visible: { energy: true }, order: ['energy'] });
    const snapshot = snapshotWeqSettings({ ...DEFAULT_APP_SETTINGS, contactCard });
    expect(() => validateWeqAppSettings(snapshot)).not.toThrow();
    expect(snapshot.contactCard).toEqual(contactCard);
    expect(normalizeContactCard(JSON.parse(JSON.stringify(snapshot.contactCard)))).toEqual(
      contactCard,
    );
  });
  it('按确认默认值配置，能量值独立且不含等级或动作开关', () => {
    const value = normalizeContactCard(null);
    expect(value).toEqual(DEFAULT_CONTACT_CARD);
    for (const key of [
      'age',
      'birthday',
      'company',
      'description',
      'email',
      'notes',
      'school',
      'status',
      'common',
      'relations',
      'groupLevel',
      'joinedAt',
      'lastSpeakAt',
    ] as const)
      expect(value.visible[key]).toBe(true);
    for (const key of [
      'signatureUpdated',
      'occupation',
      'constellation',
      'zodiac',
      'bloodType',
      'energy',
      'friendClue',
    ] as const)
      expect(value.visible[key]).toBe(false);
    expect(CONTACT_CARD_FIELDS.map(([key]) => key)).not.toContain('energyLevel');
    expect(Object.keys(value.visible)).not.toContain('edit');
  });
  it('保留开关与排序、去重未知项并补齐新增项，不复活旧等级', () => {
    const value = normalizeContactCard({
      visible: {
        energy: true,
        company: false,
        description: false,
        email: false,
        energyLevel: true,
      },
      order: ['energy', 'energy', 'unknown', 'company'],
      groupOrder: ['joinedAt'],
    });
    expect(value.order.slice(0, 2)).toEqual(['energy', 'company']);
    expect(value.order).toHaveLength(DEFAULT_CONTACT_CARD.order.length);
    expect(value.visible.energy).toBe(true);
    expect(value.visible.company).toBe(false);
    expect(value.visible.description).toBe(false);
    expect(value.visible.email).toBe(false);
    expect(value.visible).not.toHaveProperty('energyLevel');
    expect(value.groupOrder).toEqual(['joinedAt', 'groupLevel', 'lastSpeakAt']);
  });
  it('调序不改原数组，首尾和缺失项不越界', () => {
    const keys = [...DEFAULT_CONTACT_CARD.order];
    expect(moveContactCardField(keys, keys[1]!, -1).slice(0, 2)).toEqual([keys[1], keys[0]]);
    expect(moveContactCardField(keys, keys[0]!, -1)).toBe(keys);
    expect(keys).toEqual(DEFAULT_CONTACT_CARD.order);
  });
});
describe('资料等级与获赞按需读取', () => {
  function service() {
    return new PeerStatsService({ sendOidbPacket: vi.fn() }, {} as AccountSession, () => 1);
  }
  it('只开等级不发获赞查询', async () => {
    const value = service();
    const level = vi.spyOn(value, 'getQqLevel').mockResolvedValue(32);
    const likes = vi.spyOn(value, 'getLikeCount').mockResolvedValue(7);
    expect(await value.getPeerStats('10002', 'u_fixture', ['level'])).toEqual({
      level: 32,
      likeCount: null,
    });
    expect(level).toHaveBeenCalledOnce();
    expect(likes).not.toHaveBeenCalled();
  });
  it('省略字段兼容两项读取，单项失败不丢成功字段', async () => {
    const value = service();
    vi.spyOn(value, 'getQqLevel').mockResolvedValue(32);
    const likes = vi.spyOn(value, 'getLikeCount').mockRejectedValue(new Error('合成获赞失败'));
    expect(await value.getPeerStats('10002', 'u_fixture')).toEqual({ level: 32, likeCount: null });
    expect(likes).toHaveBeenCalledOnce();
    await expect(value.getPeerStats('10002', 'u_fixture', ['likeCount'])).rejects.toThrow(
      '合成获赞失败',
    );
  });
});
