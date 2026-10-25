/**
 * 自己头像上叠的 QQ 挂件（appId 4）。
 *
 * 只作为自己头像的静态回退；消息记录和本地装扮里的头像挂件优先。
 * 素材来自 bootstrap 存下的 `homeDress.widgetUrl`，这里不发网络请求。
 *
 * 走 context 而不是让每个 `Avatar` 自己 useQuery：气泡是每条消息一个实例，挂几百个
 * 订阅会在缓存失效时全量重渲。provider 在 App.tsx（要包住 ForwardWindowHost——
 * 转发窗口里的气泡在 MainView 之外）。
 */

import { createContext, useContext } from 'react';

/** 挂件图片 url（已过 weq-media 代理）；空串 = 不叠。 */
export const SelfPendantContext = createContext<string>('');

/** 发送预备快照返回前，先按账号配置画气泡；真实记录不得使用此回退。 */
export const SelfBubbleContext = createContext<number>(0);

export function useSelfBubble(): number {
  return useContext(SelfBubbleContext);
}

export function useSelfPendant(): string {
  return useContext(SelfPendantContext);
}
