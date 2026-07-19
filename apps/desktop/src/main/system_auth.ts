import { systemPreferences, type BrowserWindow } from 'electron';
import { requirePlatform } from './context/app_context';

export type SystemAuthStatus = {
  platform: NodeJS.Platform;
  available: boolean;
  method: 'windows-hello' | 'touch-id' | 'none';
  displayName: string;
  error?: string;
};

export type SystemAuthVerifyResult = {
  success: boolean;
  method: 'windows-hello' | 'touch-id' | 'none';
  error?: string;
};

class SystemAuthService {
  getStatus(): SystemAuthStatus {
    if (process.platform === 'win32') {
      return {
        platform: process.platform,
        available: false,
        method: 'none',
        displayName: 'Windows Hello',
        error: '正在检测 Windows Hello 状态。',
      };
    }

    if (process.platform === 'darwin') {
      const available = systemPreferences.canPromptTouchID();
      return {
        platform: process.platform,
        available,
        method: available ? 'touch-id' : 'none',
        displayName: 'Touch ID',
        error: available ? undefined : '当前设备不支持 Touch ID 或未启用。',
      };
    }

    return {
      platform: process.platform,
      available: false,
      method: 'none',
      displayName: '系统认证',
      error: `当前平台暂不支持系统认证：${process.platform}`,
    };
  }

  resolveStatus(): SystemAuthStatus {
    if (process.platform === 'win32') {
      try {
        const result = requirePlatform().native.ntHelper.checkWindowsHelloAvailability();
        return {
          platform: process.platform,
          available: result.available,
          method: result.available ? 'windows-hello' : 'none',
          displayName: 'Windows Hello',
          ...(result.available ? {} : { error: this.mapAvailabilityError(result.code) }),
        };
      } catch (error) {
        return {
          platform: process.platform,
          available: false,
          method: 'none',
          displayName: 'Windows Hello',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    return this.getStatus();
  }

  async verify(reason?: string, _targetWindow?: BrowserWindow): Promise<SystemAuthVerifyResult> {
    if (process.platform === 'win32') {
      try {
        const result = requirePlatform().native.ntHelper.verifyWindowsHello(
          reason || '请验证您的身份以解锁 WeQ',
          null,
        );
        if (result.success) {
          return { success: true, method: 'windows-hello' };
        }
        return {
          success: false,
          method: 'windows-hello',
          error: this.mapVerificationError(result.code),
        };
      } catch (error) {
        return {
          success: false,
          method: 'windows-hello',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    const status = this.getStatus();
    if (!status.available) {
      return {
        success: false,
        method: status.method,
        error: status.error ?? '当前设备不可用。',
      };
    }

    try {
      await systemPreferences.promptTouchID(reason || '请验证您的身份');
      return { success: true, method: 'touch-id' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        method: 'touch-id',
        error: message.includes('User canceled') ? '用户取消了 Touch ID 验证。' : message,
      };
    }
  }

  private mapAvailabilityError(code: number): string {
    switch (code) {
      case 1:
        return '当前设备不支持 Windows Hello。';
      case 2:
        return '当前用户尚未配置 Windows Hello。';
      case 3:
        return 'Windows Hello 被系统策略禁用。';
      case 4:
        return 'Windows Hello 当前正忙，请稍后重试。';
      case 100:
        return '当前平台暂不支持 Windows Hello。';
      default:
        return `Windows Hello 当前不可用（代码 ${code}）。`;
    }
  }

  private mapVerificationError(code: number): string {
    switch (code) {
      case 1:
        return '当前设备不支持 Windows Hello。';
      case 2:
        return '当前用户尚未配置 Windows Hello。';
      case 3:
        return 'Windows Hello 被系统策略禁用。';
      case 4:
        return 'Windows Hello 当前正忙，请稍后重试。';
      case 5:
        return '验证次数过多，请稍后再试。';
      case 6:
        return '已取消 Windows Hello 验证。';
      case 100:
        return '当前平台暂不支持 Windows Hello。';
      default:
        return `Windows Hello 验证失败（代码 ${code}）。`;
    }
  }
}

export const systemAuthService = new SystemAuthService();
