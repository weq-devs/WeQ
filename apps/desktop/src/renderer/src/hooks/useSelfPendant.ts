/**
 * 自己头像上叠的 QQ 挂件（appId 4）。
 *
 * 只作用于**自己**的头像：素材来自 bootstrap 存下的 `homeDress.widgetUrl`（一次性，
 * 无网络），而他人的挂件要逐个走 SSR 装扮页查——每条消息一次网络往返不现实，
 * 想看别人的挂件请走资料卡的「个性主页」。
 *
 * 走 context 而不是让每个 `Avatar` 自己 useQuery：气泡是每条消息一个实例，挂几百个
 * 订阅会在缓存失效时全量重渲。provider 在 App.tsx（要包住 ForwardWindowHost——
 * 转发窗口里的气泡在 MainView 之外）。
 */

import { createContext, useContext } from 'react';

/** 挂件图片 url（已过 weq-media 代理）；空串 = 不叠。 */
export const SelfPendantContext = createContext<string>('');

export function useSelfPendant(): string {
  return useContext(SelfPendantContext);
}
