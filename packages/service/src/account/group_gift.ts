/**
 * 群礼物面板 —— 只读。
 *
 * 走 `trpc.qqva.gift_midground_panel.GiftMidgroundPanel.SsoGetSceneItem`
 * （见 `@weq/protocol` 的 `group-gift-panel`），需要已 attach 的在线 QQ 进程。
 * 面板是纯查询，不涉及下单 / 付款。
 */

import { GroupGiftPanel, type GroupGiftPanelResult, type TrpcNative } from '@weq/protocol';

export class GroupGiftService {
  constructor(
    private readonly nt: TrpcNative,
    private readonly resolvePid: () => number,
  ) {}

  /** 拉取某个群的礼物面板（全部页签 + 礼物）。 */
  async getPanel(groupUin: number | string): Promise<GroupGiftPanelResult> {
    return GroupGiftPanel.invoke(this.nt, this.resolvePid(), { groupUin });
  }
}
