/**
 * 闪照兜底文案的识别（渲染层）。
 *
 * 本地库里闪照只剩一句 `[闪照]请使用新版手机QQ查看闪照。`，`commonElem(serviceType=3)`
 * 元素从来没落过库。渲染层靠这句话认出「这条需要走协议补拉」，所以判据必须严格：
 * 只有**整条消息恰好是一条这样的文本**才算，正常聊天里提到这句话的句子不算。
 */

import { describe, expect, it } from 'vitest';
import {
  classifyFlashPhotoFetch,
  FLASH_PHOTO_MAX_ATTEMPTS,
  FLASH_PHOTO_PLACEHOLDER_TEXT,
  isFlashPhotoPlaceholderText,
  isTransientFlashPhotoFailure,
  pickFlashPhotoFetch,
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
    expect(isTransientFlashPhotoFailure('error', SSO_NOT_REGISTERED)).toBe(true);
  });

  it('offline 一律算瞬时：QQ 没起来 / 完全离线模式都会自己恢复', () => {
    expect(isTransientFlashPhotoFailure('offline', 'QQ 未在线，无法拉取缺失消息')).toBe(true);
  });

  it('网络类的报错也算瞬时', () => {
    for (const message of ['连接超时', 'read ECONNRESET', 'Request timeout', 'network unreachable'])
      expect(isTransientFlashPhotoFailure('error', message)).toBe(true);
  });

  it('服务端明确没有这条的失败不算瞬时（别无限重试）', () => {
    expect(
      isTransientFlashPhotoFailure(
        'error',
        '漫游响应的账号、会话或 NT 序号不一致，未提交本窗覆盖。',
      ),
    ).toBe(false);
    expect(
      isTransientFlashPhotoFailure('error', '漫游缓存卷可用空间不足 1 GiB，未派发请求。'),
    ).toBe(false);
  });

  it('重试上限是个正数，重试逻辑靠它收口', () => {
    expect(FLASH_PHOTO_MAX_ATTEMPTS).toBeGreaterThan(1);
  });
});

describe('从补拉结果里挑闪照', () => {
  // 真实样本：同一条消息，本地库和服务端给的是两套 msgId。
  const LOCAL_MSG_ID = '7702493945254447733';
  const ROAMING_MSG_ID = '72057595742500046';
  const SEQ = '2859';

  const flashRow = (msgSeq: string) => ({
    msgSeq,
    elements: [{ type: 'pic', data: { isFlash: true, fileToken: '/2863253201-1-ABC' } }],
    sourceFormat: 'protocol' as const,
  });

  it('按 seq 匹配，不按 msgId（两边 msgId 本来就不一样）', () => {
    expect(LOCAL_MSG_ID).not.toBe(ROAMING_MSG_ID);
    const picked = pickFlashPhotoFetch([flashRow(SEQ)], SEQ);
    expect(picked).not.toBeNull();
    expect(picked!.msgSeq).toBe(SEQ);
  });

  it('seq 对不上就不挑', () => {
    expect(pickFlashPhotoFetch([flashRow('3000')], SEQ)).toBeNull();
  });

  it('同一 seq 但元素里没有 isFlash 时不算数', () => {
    const notFlash = {
      msgSeq: SEQ,
      elements: [{ type: 'text', data: { textContent: '普通文本' } }],
      sourceFormat: 'protocol' as const,
    };
    expect(pickFlashPhotoFetch([notFlash], SEQ)).toBeNull();
  });
});

describe('补拉结果的三种结局', () => {
  const base = { fetchedRows: 1, picked: false };

  it('拿到闪照 → replace', () => {
    expect(classifyFlashPhotoFetch({ ...base, ok: true, picked: true })).toBe('replace');
  });

  it('丢了零条 → retry：SSO 断连重连时服务端会回空包，不代表「没有这条」', () => {
    expect(classifyFlashPhotoFetch({ ...base, ok: true, fetchedRows: 0 })).toBe('retry');
  });

  it('窗口有消息但没有闪照元素 → give-up，别再打', () => {
    expect(classifyFlashPhotoFetch({ ...base, ok: true })).toBe('give-up');
  });

  it('SSO 未登记这类瞬时失败 → retry', () => {
    expect(
      classifyFlashPhotoFetch({
        ...base,
        ok: false,
        reason: 'error',
        message: 'pid 67312 还没有登记 SSO 会话（先调用 setSsoSession）',
      }),
    ).toBe('retry');
  });

  it('服务端身份校验失败这类永久失败 → give-up', () => {
    expect(
      classifyFlashPhotoFetch({
        ...base,
        ok: false,
        reason: 'error',
        message: '漫游响应的账号、会话或 NT 序号不一致，未提交本窗覆盖。',
      }),
    ).toBe('give-up');
  });
});
