import { describe, expect, it } from 'vitest';
import {
  FLASH_PHOTO_PLACEHOLDER_TEXT,
  isFlashPhotoPlaceholderText,
  isTransientMessageBackfillFailure,
} from '../src/renderer/src/lib/flashPhoto';

describe('闪照兜底文案', () => {
  it('文案与协议层常量一致（两处必须一起改）', () => {
    expect(FLASH_PHOTO_PLACEHOLDER_TEXT).toBe('[闪照]请使用新版手机QQ查看闪照。');
  });

  it('完全一致才算（含首尾空白）', () => {
    expect(isFlashPhotoPlaceholderText(FLASH_PHOTO_PLACEHOLDER_TEXT)).toBe(true);
    expect(isFlashPhotoPlaceholderText(`  ${FLASH_PHOTO_PLACEHOLDER_TEXT}\n`)).toBe(true);
  });

  it('只是包含这句话的普通句子不算', () => {
    expect(isFlashPhotoPlaceholderText(`他说${FLASH_PHOTO_PLACEHOLDER_TEXT}`)).toBe(false);
    expect(isFlashPhotoPlaceholderText('[闪照]')).toBe(false);
    expect(isFlashPhotoPlaceholderText('')).toBe(false);
  });
});

describe('闪照补拉的失败分类', () => {
  // 线上踩过的真实错误串：QQ 刚上线，SSO 会话还没登记（Linux 要先提权读内存）。
  const SSO_NOT_REGISTERED = 'pid 29379 还没有登记 SSO 会话（先调用 setSsoSession）';

  it('SSO 会话未登记算瞬时失败（凭据就绪后还能再拉）', () => {
    expect(isTransientMessageBackfillFailure('error', SSO_NOT_REGISTERED)).toBe(true);
  });

  it('offline 一律算瞬时：QQ 没起来 / 完全离线模式都会自己恢复', () => {
    expect(isTransientMessageBackfillFailure('offline', 'QQ 未在线，无法拉取缺失消息')).toBe(true);
  });

  it('网络类的报错也算瞬时', () => {
    for (const message of ['连接超时', 'read ECONNRESET', 'Request timeout', 'network unreachable'])
      expect(isTransientMessageBackfillFailure('error', message)).toBe(true);
  });

  it('服务端明确没有这条的失败不算瞬时（别无限重试）', () => {
    expect(
      isTransientMessageBackfillFailure(
        'error',
        '漫游响应的账号、会话或 NT 序号不一致，未提交本窗覆盖。',
      ),
    ).toBe(false);
    expect(
      isTransientMessageBackfillFailure('error', '漫游缓存卷可用空间不足 1 GiB，未派发请求。'),
    ).toBe(false);
  });
});
