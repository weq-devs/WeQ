/**
 * 本端摄像头采集（渲染层半边）。
 *
 * 只是把「怎么拿摄像头流」交给 {@link useVideoCapture}；采集 → 缩放 → I420 → 推帧
 * 那一段与屏幕共享共用，见 `useVideoCapture.ts`。
 *
 * 摄像头与屏幕共享**互斥**：同一时刻只有一路主视频流（协议侧也只有一个主画面
 * 子类型）。切换由 `CallWindow` 决定，两个 hook 各自只在 `enabled` 时采集。
 */

import { useCallback } from 'react';
import { CAMERA_PROFILE, type VideoProfile } from '../../../shared/call_video_profile';
import { useVideoCapture, type CaptureState } from './useVideoCapture';

export type CallCameraState = CaptureState;

/**
 * 摄像头采集。
 *
 * `enabled` 由通话窗口的摄像头按钮控制；关掉时立即停止采集并关掉轨道
 * （摄像头指示灯随之熄灭）。
 */
export function useCallCamera(options: {
  enabled: boolean;
  profile?: VideoProfile;
  onEnded?: () => void;
}): CallCameraState {
  const { enabled, profile = CAMERA_PROFILE, onEnded } = options;

  const openStream = useCallback(async (target: { width: number; height: number; fps: number }) => {
    // 调试用：按 label 或 deviceId 指定摄像头。
    //
    // 同机同时跑 QQ 与 WeQ 时，两边会争抢同一个物理摄像头（v4l2 是独占打开的），
    // 谁后开谁拿不到 —— 表现为本端画面一片空白。用 v4l2loopback 造一路虚拟
    // 摄像头（`modprobe v4l2loopback video_nr=10 card_label="WeQ Virtual"`，
    // 再用 ffmpeg 往里推测试图案），然后在这里指定它。
    //
    //   WEQ_CAMERA_LABEL="WeQ Virtual" pnpm --filter @weq/desktop dev
    //
    // 走 label 匹配而不是写死 deviceId：deviceId 每次插拔都会变，label 稳定。
    const wanted = window.weq?.cameraLabel;
    if (wanted) {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const match = devices.find((d) => d.kind === 'videoinput' && d.label.includes(wanted));
      if (match) {
        return navigator.mediaDevices.getUserMedia({
          video: {
            deviceId: { exact: match.deviceId },
            width: { ideal: target.width },
            height: { ideal: target.height },
            frameRate: { ideal: target.fps },
          },
          audio: false,
        });
      }
      console.warn(`[call] 没找到标签含「${wanted}」的摄像头，回退默认设备`);
    }
    return navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: target.width },
        height: { ideal: target.height },
        frameRate: { ideal: target.fps },
      },
      audio: false,
    });
  }, []);

  return useVideoCapture({
    enabled,
    profile,
    openStream,
    unsupportedMessage: '当前环境不支持摄像头采集',
    onEnded,
  });
}

// 兼容旧的导入路径：`rgbaToI420` 原来定义在这里，已有调用方（含测试）从
// useCallCamera 引入。实现已经搬到 useVideoCapture，这里重新导出。
export { rgbaToI420 } from './useVideoCapture';
