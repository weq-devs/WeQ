import { describe, expect, it } from 'vitest';
import { DEFAULT_CONTACT_CARD } from '@weq/service/contact-card';
import type { SettingsResetItem } from '../src/shared/settings_reset';
import {
  describeSettingsReset,
  formatResetValue,
} from '../src/renderer/src/lib/settingsResetPreview';

const item = (id: string, current: unknown, defaultValue: unknown): SettingsResetItem => ({
  id,
  current,
  defaultValue,
  label: '合成设置',
  scope: '全局',
});

describe('恢复默认设置的可读预览', () => {
  it('省流量卡片按中文设置名展示实际变化，不输出内部字段', () => {
    const defaults = {
      dataSaverMode: 'auto',
      dataSaverImageLoading: 'thumbnail',
      dataSaverLargeMiB: 10,
      dataSaverDress: false,
    };
    expect(
      describeSettingsReset(
        item(
          'data-saver:preferences',
          { ...defaults, dataSaverMode: 'always', dataSaverLargeMiB: 25 },
          defaults,
        ),
      ),
    ).toEqual([
      { label: '省流量模式', text: '开启 → 跟随系统' },
      { label: '大文件暂停阈值', text: '25 MiB → 10 MiB' },
    ]);
  });
  it('名片只列出实际改变的中文字段和分区顺序', () => {
    const current = structuredClone(DEFAULT_CONTACT_CARD);
    current.visible.constellation = true;
    current.visible.age = false;
    [current.order[4], current.order[5]] = [current.order[5]!, current.order[4]!];
    expect(
      describeSettingsReset(item('contact-card:contactCard', current, DEFAULT_CONTACT_CARD)),
    ).toEqual([
      { label: '将显示', text: '年龄' },
      { label: '将隐藏', text: '星座' },
      {
        label: '个人资料顺序',
        text: '性别 → 年龄 → 生日 → 星座 → 生肖 → 血型 → 所在地 → 职业 → 学校 → 个人说明 → 公司 → 邮箱',
      },
    ]);
  });
  it('默认名片给出简短摘要，群资料顺序使用中文名称', () => {
    expect(
      describeSettingsReset(
        item('contact-card:contactCard', DEFAULT_CONTACT_CARD, DEFAULT_CONTACT_CARD),
      ),
    ).toEqual([{ label: '已是默认', text: '字段显示与排列顺序均为默认设置' }]);
    const current = structuredClone(DEFAULT_CONTACT_CARD);
    current.groupOrder.reverse();
    expect(
      describeSettingsReset(item('contact-card:contactCard', current, DEFAULT_CONTACT_CARD)),
    ).toEqual([{ label: '群内资料顺序', text: '群等级 → 入群时间 → 最后群发言时间' }]);
  });
  it('复杂值不泄露 JSON 或内部会话标识', () => {
    expect(formatResetValue({ enabled: true, screenshot: false })).toBe(
      '链接预览：开启；网页截图：关闭',
    );
    expect(formatResetValue([{ kind: 'c2c', conv: 'synthetic-id' }], 'typing:selection')).toBe(
      '已选择 1 个会话',
    );
    expect(formatResetValue([], 'typing:selection')).toBe('未选择会话');
    expect(formatResetValue({ futureField: true })).toBe('自定义配置');
  });
  it('同一枚举在不同设置中保留实际含义，并补充单位', () => {
    expect(formatResetValue('all', 'recall-scope:scope')).toBe('全部会话');
    expect(formatResetValue('all', 'typing:mode')).toBe('全部会话');
    expect(formatResetValue('light', 'theme-mode:preference')).toBe('浅色');
    expect(formatResetValue('paper', 'theme-background:background')).toBe('纸感');
    expect(formatResetValue(5, 'toast:successSeconds')).toBe('5 秒');
    expect(formatResetValue(256, 'image-cache:chatImageCacheMiB')).toBe('256 MiB');
    expect(formatResetValue(0, 'app-lock:autoLockMinutes')).toBe('不自动锁定');
    expect(formatResetValue(-1, 'toast:failureSeconds')).toBe('不自动关闭');
    expect(formatResetValue(-1, 'update:interval')).toBe('不自动检查');
    expect(formatResetValue(-1, 'suggestion-cache:suggestionExpiryMinutes')).toBe('永不过期');
    expect(formatResetValue(0, 'suggestion-cache:suggestionExpiryMinutes')).toBe('立即过期');
    expect(formatResetValue(true, 'damage-reminder:suppressDbDamageReminder')).toBe('不再提醒');
    expect(formatResetValue(['home', 'off'])).toBe('home、off');
    expect(formatResetValue(undefined)).toBe('当前状态未知');
  });
});
