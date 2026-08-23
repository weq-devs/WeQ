/**
 * WeQ 验证器 —— 应用锁的 TOTP（RFC 6238）认证服务。
 *
 * 与 Windows Hello / Touch ID（system_auth.ts）并列：默认解锁方式。
 * 密钥以 Base32 形式持久化在 config.json 的 `totpSecret` 字段（UserConfig），
 * 只在主进程读写，绝不通过 getSettings / IPC 暴露明文给渲染层。
 *
 * 绑定流程是「先生成、验证通过才落盘」：generateSetup() 只把新密钥放在内存
 * （pendingSecret），等用户在自己的验证器 App 里录入并回填 6 位码、verify()
 * 校验通过后才真正持久化。中途取消（cancelSetup）直接丢弃，不会出现「界面已
 * 绑定但用户手里没有密钥」的锁死状态。
 *
 * 防爆破：连续输错多次后短暂锁定，防止 6 位验证码被暴力枚举。
 */

import { generateSecret, generateURI, verifySync } from 'otplib';
import { getLogger } from '@weq/service';
import { requireBootstrap } from './context/app_context';

const ISSUER = 'WeQ';
const LABEL = 'WeQ';
const TOTP_DIGITS = 6;
const TOTP_PERIOD = 30;
const TOTP_ALGORITHM = 'sha1';
/** 容差 ±30s = 前后各 1 个时间步，容忍设备时钟漂移。 */
const TOTP_EPOCH_TOLERANCE = TOTP_PERIOD;

/** 连续失败 N 次后进入短暂锁定。 */
const MAX_FAILURES = 5;
const LOCK_MS = 30_000;

const logger = getLogger().child({ scope: 'totp-auth' });

export type TotpStatus = {
  /** 是否已绑定验证器（密钥已生成并持久化）。 */
  configured: boolean;
  /** otpauth URI 使用的发行方 / 账户名。 */
  issuer: string;
  label: string;
};

class TotpAuthService {
  private failures = 0;
  private lockedUntil = 0;
  /** 绑定流程中的新密钥，验证通过前不落盘。 */
  private pendingSecret: string | null = null;

  getStatus(): TotpStatus {
    return { configured: this.secret() !== null, issuer: ISSUER, label: LABEL };
  }

  /**
   * 生成新密钥（仅内存待确认）。返回一次性展示材料（明文密钥 + otpauth URL），
   * 供设置页画二维码 / 手动录入；用户回填验证码并校验通过后才会持久化。
   */
  generateSetup(): { secret: string; otpauthUrl: string } {
    const secret = generateSecret({ length: 20 });
    const otpauthUrl = generateURI({
      issuer: ISSUER,
      label: LABEL,
      secret,
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD,
      algorithm: TOTP_ALGORITHM,
    });
    this.pendingSecret = secret;
    this.resetThrottle();
    logger.info('authenticator secret generated (pending confirmation)', {
      event: 'totp-setup-generated',
    });
    return { secret, otpauthUrl };
  }

  /** 取消绑定流程，丢弃待确认的新密钥。 */
  cancelSetup(): { ok: boolean } {
    if (this.pendingSecret) {
      logger.info('authenticator setup cancelled', { event: 'totp-setup-cancelled' });
    }
    this.pendingSecret = null;
    this.resetThrottle();
    return { ok: true };
  }

  verify(code: unknown): { ok: boolean; error?: string } {
    // 待确认的新密钥优先；否则用已绑定的密钥（解锁场景）。
    const secret = this.pendingSecret ?? this.secret();
    if (!secret) {
      return { ok: false, error: '尚未绑定验证器，请先在 设置 → 应用锁 中完成配置。' };
    }
    if (this.isLocked()) {
      const wait = Math.max(1, Math.ceil((this.lockedUntil - Date.now()) / 1000));
      return { ok: false, error: `尝试次数过多，请在 ${wait} 秒后重试。` };
    }
    if (typeof code !== 'string') {
      return { ok: false, error: '验证码格式不正确。' };
    }
    const token = code.replace(/\s+/g, '');
    if (!/^\d{6}$/.test(token)) {
      return { ok: false, error: '验证码应为 6 位数字。' };
    }

    try {
      const result = verifySync({
        secret,
        token,
        digits: TOTP_DIGITS,
        period: TOTP_PERIOD,
        algorithm: TOTP_ALGORITHM,
        epochTolerance: TOTP_EPOCH_TOLERANCE,
      });
      if (result.valid) {
        // 绑定确认成功 → 新密钥落盘；解锁成功 → 维持现状。
        if (this.pendingSecret) {
          requireBootstrap().userConfig.setTotpSecret(this.pendingSecret);
          this.pendingSecret = null;
          logger.info('authenticator secret confirmed and persisted', {
            event: 'totp-setup-confirmed',
          });
        }
        this.resetThrottle();
        return { ok: true };
      }
    } catch (error) {
      logger.warn('totp verification failed unexpectedly', {
        event: 'totp-verify-error',
        error: error instanceof Error ? error.message : String(error),
      });
      return { ok: false, error: '验证器校验异常，请稍后重试。' };
    }

    this.failures += 1;
    if (this.failures >= MAX_FAILURES) {
      this.lockedUntil = Date.now() + LOCK_MS;
      this.failures = 0;
      return { ok: false, error: '连续错误次数过多，已锁定 30 秒，请稍后再试。' };
    }
    return { ok: false, error: '验证码错误或已过期，请重试。' };
  }

  /** 解除绑定：清除密钥。 */
  remove(): { ok: boolean } {
    requireBootstrap().userConfig.setTotpSecret(null);
    this.pendingSecret = null;
    this.resetThrottle();
    logger.info('authenticator secret removed', { event: 'totp-remove' });
    return { ok: true };
  }

  private secret(): string | null {
    return requireBootstrap().userConfig.getTotpSecret();
  }

  private isLocked(): boolean {
    return Date.now() < this.lockedUntil;
  }

  private resetThrottle(): void {
    this.failures = 0;
    this.lockedUntil = 0;
  }
}

export const totpAuthService = new TotpAuthService();
