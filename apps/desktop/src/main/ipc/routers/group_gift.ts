/**
 * `account.groupGift.*` —— 群礼物面板（只读）。
 *
 * 走裸 SSO `GiftMidgroundPanel.SsoGetSceneItem`（见 `@weq/protocol` 的
 * `group-gift-panel`），需要在线 QQ 实例；完全离线模式下直接报错，由渲染层回落到
 * 内置抓包示例并弹错误提示。这里**没有任何写操作**：不下单、不付款。
 */

import { z } from 'zod';
import { getAppContext, type AccountServices } from '../../context/app_context';
import { fullModeAllowed } from '../../context/full_mode';
import { procedure, router } from '../trpc';

function requireServices(): AccountServices {
  const ctx = getAppContext();
  if (!ctx.services) {
    throw new Error('No account session open — call bootstrap.openAccount first.');
  }
  return ctx.services;
}

/** SSO 发包需要在线 QQ + 未开启完全离线模式。 */
function requireOnline(services = requireServices()): void {
  const record = services.accountConfig.getRecord();
  if (!(record?.qqOnline && record.qqPid)) {
    throw new Error('群礼物需要先登录该账号的 QQ 客户端。');
  }
  if (!fullModeAllowed(getAppContext())) {
    throw new Error('已开启完全离线模式，群礼物需要在线 QQ 实例。');
  }
}

export const groupGiftRouter = router({
  /** 拉取某个群的礼物面板：页签 + 每件礼物的价格 / 魅力值 / 预览图。 */
  scene: procedure
    .input(z.object({ groupUin: z.number().int().safe().positive() }))
    .query(async ({ input }) => {
      const services = requireServices();
      requireOnline(services);
      return services.groupGift.getPanel(input.groupUin);
    }),
});
