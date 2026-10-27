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

  const openStream = useCallback(
    (target: { width: number; height: number; fps: number }) =>
      navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: target.width },
          height: { ideal: target.height },
          frameRate: { ideal: target.fps },
        },
        audio: false,
      }),
    [],
  );

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
