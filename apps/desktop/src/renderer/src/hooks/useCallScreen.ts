/**
 * 本端**屏幕共享**采集（渲染层半边）。
 *
 * 协议侧与摄像头完全一致 —— 屏幕共享就是一路普通主视频流，只是采集源换成了
 * 屏幕。所以这里不做任何协议层面的特殊处理，拿到流之后与 {@link useCallCamera}
 * 走同一条 `useVideoCapture` 管线。
 *
 * ## 四端怎么拿到流
 *
 * 统一用 `getDisplayMedia`，让 Electron / Chromium 按平台自己选后端：
 *
 * | 平台 | 实际后端 |
 * | --- | --- |
 * | Windows | WGC（Win10 1903+）/ DXGI |
 * | macOS | ScreenCaptureKit |
 * | Linux X11 / XWayland | XDG Portal ScreenCast → PipeWire |
 * | Linux Wayland | XDG Portal ScreenCast → PipeWire |
 *
 * 注意 **Linux 下即使以 `--ozone-platform=x11`（XWayland）跑，采集仍然走 portal**
 * —— 2026-10-28 本机实测日志里是 `shared_screencast_stream.cc`。也就是说 X11 与
 * Wayland 在本项目里是同一条代码路径，不需要像 OBS 那样分 `x11grab` 与
 * `pipewire` 两套实现。
 *
 * ## 为什么源不能用 `getSources` 自己挑
 *
 * Linux 的 portal 弹窗由桌面环境提供（Hyprland / KDE / GNOME 各自风格），选哪一个
 * 源、是否允许，用户在那里决定，应用拿不到「先选好再传给我」的余地。所以这里
 * 统一让 portal 弹窗做选择，不自己画选源面板 —— 自己画的话 Linux 上会连弹两次。
 *
 * macOS 15+ 的 Electron 还能用 `useSystemPicker` 走系统原生选择器；Windows 与
 * Linux 没有等价的系统级选择器，由主进程的 `setDisplayMediaRequestHandler`
 * 决定给哪个源（见 `main/call_display_media.ts`）。
 *
 * ## 权限
 *
 * - macOS 需要在 Info.plist 里有屏幕录制用途说明，并在系统设置里授权；
 * - Linux 由 portal 弹窗授权，Hyprland/wlroots 下还会记住上一次的选择；
 * - Windows 不需要额外授权。
 */

import { useCallback } from 'react';
import { SCREEN_PROFILE, type VideoProfile } from '../../../shared/call_video_profile';
import { useVideoCapture, type CaptureState } from './useVideoCapture';

export type CallScreenState = CaptureState;

/** `getDisplayMedia` 的失败原因里，用户主动取消不是错误。 */
function isUserCancel(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name ?? '';
  // Chromium：NotAllowedError 同时用于「用户拒绝」和「系统策略禁止」。
  return name === 'NotAllowedError' || name === 'AbortError';
}

/**
 * 屏幕共享采集。
 *
 * `onEnded` 在**用户在系统共享栏点「停止共享」**时回调 —— 那条路径不经过我们的
 * 界面，必须由轨道 ended 事件感知，否则界面会一直停在「正在共享」。
 */
export function useCallScreen(options: {
  enabled: boolean;
  profile?: VideoProfile;
  /** 用户主动结束共享（系统栏 / 浏览器内置控件）时调用。 */
  onEnded?: () => void;
}): CallScreenState {
  const { enabled, profile = SCREEN_PROFILE, onEnded } = options;

  const openStream = useCallback(async (target: { width: number; height: number; fps: number }) => {
    // 约束直接带给采集端：让它在 PipeWire / ScreenCaptureKit 那一层就交出目标
    // 尺寸，省掉一次 1920×1080 → 1280×720 的缩放（本机实测 20 ms/帧）。
    // `resizeMode` 由 Chromium 按「等比缩放 + 裁切」处理，不会拉伸。
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: target.width, max: target.width },
        height: { ideal: target.height, max: target.height },
        frameRate: { ideal: target.fps },
      },
      // 屏幕共享的声音不走这条流：通话上行的音频只来自麦克风，电脑声音只在
      // 录音时单独采集（见 useCallRecorder）。要了也用不上，还会多占一路捕获。
      audio: false,
    });
    return stream;
  }, []);

  return useVideoCapture({
    enabled,
    profile,
    openStream,
    unsupportedMessage: '当前环境不支持屏幕共享',
    onEnded: () => {
      // 用户取消不是错误，交给上层把状态切回「未共享」即可。
      onEnded?.();
    },
  });
}

export { isUserCancel };
