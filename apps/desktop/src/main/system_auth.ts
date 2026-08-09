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
  /**
   * win32 的可用性探测结果。native 的 checkWindowsHelloAvailability() 是同步
   * 调用（会阻塞主进程 ~百毫秒级），而结果在一次运行内不会变，所以只探一次
   * 并缓存 —— 否则每次进设置页都要卡一下。
   */
  private win32Availability: SystemAuthStatus | null = null;
  private win32Probe: Promise<SystemAuthStatus> | null = null;

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

  /**
   * 可用性探测。win32 上把同步 native 调用挪到 setImmediate 之后执行，让
   * ipcMain.handle 先把控制权交回事件循环 —— 渲染层的 await 照常等，但主
   * 进程不会在 IPC 处理函数里被同步卡住。结果缓存，只探一次。
   */
  async resolveStatus(): Promise<SystemAuthStatus> {
    if (process.platform !== 'win32') return this.getStatus();
    if (this.win32Availability) return this.win32Availability;
    this.win32Probe ??= new Promise<SystemAuthStatus>((resolve) => {
      setImmediate(() => resolve(this.probeWindowsHello()));
    }).then((status) => {
      this.win32Availability = status;
      this.win32Probe = null;
      return status;
    });
    return this.win32Probe;
  }

  private probeWindowsHello(): SystemAuthStatus {
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
