import { describe, expect, it } from 'vitest';
import { UserConfigService, DEFAULT_APP_SETTINGS } from '../src/bootstrap/user_config';
import {
  DEFAULT_TOAST_DURATIONS,
  isToastDuration,
  MAX_TOAST_DURATION_SECONDS,
} from '../src/common/toast_settings';
import { DEFAULT_HOME_SETTINGS, normalizeHomeSettings } from '../src/common/home_settings';
import { snapshotWeqSettings, validateWeqAppSettings } from '../src/bootstrap/backup_settings';
import { configFixture } from './support/user_config';

describe('测试版更新偏好', () => {
  it('默认关闭，独立保存且重开后保留', () => {
    const f = configFixture();
    expect(f.service.getSettings().updateCheckPrerelease).toBe(false);
    f.service.setSettings({ updateCheckPrerelease: true });
    f.service.setSettings({ preferCdn: false });
    expect(f.open().getSettings().updateCheckPrerelease).toBe(true);
    expect(snapshotWeqSettings(f.open().getSettings()).updateCheckPrerelease).toBe(true);
    f.service.setSettings({ updateCheckPrerelease: false });
    expect(f.open().getSettings().updateCheckPrerelease).toBe(false);
  });
});

describe('导出识别并发设置', () => {
  it('旧配置使用默认并发，独立修改、备份和重开后保留', () => {
    const f = configFixture();
    expect(f.service.getSettings().ocr.onlineConcurrency).toBe(
      DEFAULT_APP_SETTINGS.ocr.onlineConcurrency,
    );
    expect(f.service.getSettings().voiceTranscribe.onlineConcurrency).toBe(
      DEFAULT_APP_SETTINGS.voiceTranscribe.onlineConcurrency,
    );
    f.service.setSettings({ ocr: { onlineConcurrency: 8 } });
    f.service.setSettings({ voiceTranscribe: { onlineConcurrency: 3 } });
    f.service.setSettings({ preferCdn: false });
    const settings = f.open().getSettings();
    expect(settings.ocr.onlineConcurrency).toBe(8);
    expect(settings.voiceTranscribe.onlineConcurrency).toBe(3);
    const backup = snapshotWeqSettings(settings);
    expect(backup.voiceTranscribe.onlineConcurrency).toBe(3);
    expect(() => validateWeqAppSettings(backup)).not.toThrow();
  });

  it.each([0, 33, 1.5, '8', null])('非法并发 %s 不覆盖有效配置', (value) => {
    const f = configFixture({ settings: { ocr: { onlineConcurrency: value } } });
    expect(f.service.getSettings().ocr.onlineConcurrency).toBe(
      DEFAULT_APP_SETTINGS.ocr.onlineConcurrency,
    );
    f.service.setSettings({ ocr: { onlineConcurrency: 7 } });
    f.service.setSettings(JSON.parse(JSON.stringify({ ocr: { onlineConcurrency: value } })));
    expect(f.open().getSettings().ocr.onlineConcurrency).toBe(7);
  });
});

describe('通知偏好', () => {
  function fixture(settings = {}) {
    const f = configFixture({ settings });
    return { service: f.service, reopen: f.open };
  }

  describe('通知停留时长配置', () => {
    it('旧配置默认成功三秒、失败不自动关闭', () => {
      expect(DEFAULT_TOAST_DURATIONS).toEqual({ successSeconds: 3, failureSeconds: -1 });
      expect(fixture().service.getSettings().toastDurations).toEqual(DEFAULT_TOAST_DURATIONS);
    });
    it('两类设置独立保存，重启与修改其他偏好后仍然保留', () => {
      const f = fixture();
      f.service.setSettings({ toastDurations: { successSeconds: 6 } });
      f.service.setSettings({ toastDurations: { failureSeconds: 10 } });
      f.service.setSettings({ showMessageTime: true });
      expect(f.reopen().getSettings()).toMatchObject({
        toastDurations: { successSeconds: 6, failureSeconds: 10 },
        showMessageTime: true,
      });
      f.service.setSettings({ toastDurations: { successSeconds: -1 } });
      expect(f.reopen().getSettings().toastDurations).toEqual({
        successSeconds: -1,
        failureSeconds: 10,
      });
    });
    it.each([0, -2, 1.5, NaN, Infinity, MAX_TOAST_DURATION_SECONDS + 1, '3', null])(
      '拒绝非法时长 %s，不覆盖有效偏好',
      (value) => {
        expect(isToastDuration(value)).toBe(false);
        const f = fixture({ toastDurations: { successSeconds: value, failureSeconds: 8 } });
        expect(f.service.getSettings().toastDurations).toEqual({
          successSeconds: 3,
          failureSeconds: 8,
        });
        f.service.setSettings({ toastDurations: { successSeconds: 7 } });
        f.service.setSettings(
          JSON.parse(JSON.stringify({ toastDurations: { successSeconds: value } })),
        );
        expect(f.reopen().getSettings().toastDurations).toEqual({
          successSeconds: 7,
          failureSeconds: 8,
        });
      },
    );
  });
});

describe('个性主页', () => {
  it('旧配置默认同时展示标签、问候语和一言，独立保存后重开保留', () => {
    const { platform, service: config } = configFixture({ settings: { preferCdn: true } });
    expect(config.getSettings().home).toEqual(DEFAULT_HOME_SETTINGS);
    config.setSettings({
      home: {
        ...DEFAULT_HOME_SETTINGS,
        showTags: false,
        blockedWords: [' ABC ', 'abc', '', '剧透'],
      },
    });
    config.setSettings({ preferCdn: false });
    expect(new UserConfigService(platform).getSettings().home).toEqual({
      ...DEFAULT_HOME_SETTINGS,
      showTags: false,
      blockedWords: ['ABC', '剧透'],
    });
  });

  it('损坏或缺少的字段回落默认值，不把 false 吞掉', () => {
    expect(
      normalizeHomeSettings({ showGreeting: false, showTags: 'false', blockedWords: [42, '  '] }),
    ).toEqual({
      ...DEFAULT_HOME_SETTINGS,
      showGreeting: false,
    });
  });

  it('主页偏好随全局设置备份，屏蔽词数组可校验并拒绝损坏数据', () => {
    const backup = snapshotWeqSettings({
      ...DEFAULT_APP_SETTINGS,
      home: { ...DEFAULT_HOME_SETTINGS, blockedWords: ['剧透'] },
    });
    expect(backup.home.blockedWords).toEqual(['剧透']);
    expect(() => validateWeqAppSettings(backup)).not.toThrow();
    for (const home of [
      { blockedWords: [42] },
      { showTags: 'false' },
      { blockedWords: ['x'.repeat(201)] },
    ])
      expect(() => validateWeqAppSettings({ home })).toThrow('settings.home');
  });
});

describe('正在输入状态', () => {
  it('默认向对方展示；隐藏范围与按账号、数据源、会话的清单持久保存', () => {
    const { platform, service: config } = configFixture({ settings: { preferCdn: true } });
    expect(config.getSettings().typingStatus).toEqual({ mode: 'off', hidden: [] });
    const target = {
      accountUin: '10001',
      accountConfigId: 'source-a',
      uid: 'u_friend',
      name: '好友',
    };
    config.setTypingStatusMode('selected');
    config.setTypingStatusHidden([
      target,
      { ...target, uid: 'u_other', name: '另一个' },
      { ...target, accountUin: '10002' },
      { ...target, accountConfigId: 'source-b' },
      // 重复条目只保留第一条。
      target,
    ]);
    expect(config.getSettings().typingStatus.hidden).toHaveLength(4);
    const reopened = new UserConfigService(platform);
    expect(reopened.getSettings().typingStatus).toEqual({
      mode: 'selected',
      hidden: [
        target,
        { ...target, uid: 'u_other', name: '另一个' },
        { ...target, accountUin: '10002' },
        { ...target, accountConfigId: 'source-b' },
      ],
    });
    reopened.setTypingStatusMode('all');
    reopened.setSettings({ showMessageTime: true });
    const final = new UserConfigService(platform).getSettings();
    expect(final.typingStatus.mode).toBe('all');
    expect(final.typingStatus.hidden).toHaveLength(4);
    expect(final.preferCdn).toBe(true);
  });

  it('旧版默认关闭配置迁移为默认展示，损坏或未知配置不会误隐藏或误展示', () => {
    const legacy = configFixture({
      settings: {
        typingStatus: {
          defaultEnabled: false,
          overrides: [{ accountUin: '1', accountConfigId: 'a', uid: 'u_x', enabled: true }],
        },
      },
    });
    expect(legacy.service.getSettings().typingStatus).toEqual({ mode: 'off', hidden: [] });

    const broken = configFixture({
      settings: {
        typingStatus: { mode: 'nonsense', hidden: [null, {}, { uid: 'u_y' }] },
      },
    });
    expect(broken.service.getSettings().typingStatus).toEqual({ mode: 'off', hidden: [] });
  });
});

describe('附加提示旧配置', () => {
  describe('suppressAttachHint 的旧键（suppressPtraceHint）兼容', () => {
    it('旧配置里勾过「不再提醒」→ 读到 true，不被静默重置', () => {
      const settings = configFixture({
        settings: { suppressPtraceHint: true, preferCdn: true },
      }).service.getSettings();
      expect(settings.suppressAttachHint).toBe(true);
      expect(settings.preferCdn).toBe(true); // 相邻偏好没被弄丢
    });

    it('旧配置没勾过 → 默认仍是「会提醒」', () => {
      expect(
        configFixture({ settings: { preferCdn: true } }).service.getSettings().suppressAttachHint,
      ).toBe(false);
    });

    it('新旧键同时存在 → 新键优先', () => {
      expect(
        configFixture({
          settings: { suppressAttachHint: false, suppressPtraceHint: true },
        }).service.getSettings().suppressAttachHint,
      ).toBe(false);
    });

    it('新版里写一次 → 落盘新键，重启后仍然生效', () => {
      const f = configFixture();
      f.service.setSettings({ suppressAttachHint: true });
      expect(f.open().getSettings().suppressAttachHint).toBe(true);
    });
  });
});
