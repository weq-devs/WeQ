/**
 * 通话窗口底部的设置抽屉（默认收起）。
 *
 * **通话相关的临时开关放这里，长期配置放设置页** —— 那个窗口只有 400px 宽，
 * 录音模式 / 电脑声音 / 保存位置三项已经放不下，而且它们是「一次性配好」的东西，
 * 每次通话都摆出来反而干扰。所以这里只留：
 *
 *   - 只读的通话信息（房间号、收发帧数）
 *   - 一个跳转入口，打开设置页的「通话与录音」面板
 *
 * 真正的录音配置在 `components/settings/CallRecordingSection.tsx`，两边读的是
 * 同一份全局设置（`AppSettings.callRecording`）。
 */

import { trpc } from '../../trpc/client';

/**
 * 通话窗口里需要的录音设置（只读）。
 *
 * 抽屉不再编辑它，但窗口仍要知道默认值去启动录音 —— 与设置页共用同一份配置。
 */
export function useCallRecordingSettings() {
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
  const capabilities = trpc.call.recordingCapabilities.useQuery(undefined, {
    staleTime: 60_000,
  });
  return {
    config: settings.data?.callRecording ?? null,
    capability: capabilities.data?.systemAudio ?? null,
    /** 当前生效的录音目录（没自选时是默认那一层）。 */
    dir: capabilities.data?.dir ?? null,
  };
}
