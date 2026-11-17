/**
 * 私聊礼物商城面板 —— 输入框工具栏「红包 / 礼物」菜单里的「礼物」。
 *
 * 一栏到底：头部是标题 + 搜索，下面分栏（全部 / 礼品卡 / 个性化装扮）和子栏
 * （最近上新 / 鲜花 / 玩偶摆件 …）。点一张礼物卡进详情，详情里写祝福、可匿名，点
 * 「赠送」才下**一单**。
 *
 * 关键取舍：
 *  - 礼物图一律经 `weq-media://gift` 由主进程代取落盘（见 media_protocol），渲染进程
 *    不直连 CDN，也不为它放开 CSP。
 *  - 卡片刻意做大（每张至少 206px 宽、预览 1:1），图片 `object-fit: contain` —— 礼物
 *    的形状五花八门，裁切会毁掉观感，密排会让它们糊成一团。
 *  - 需要支付时后端会抛错，这里把**原文**摊在详情里：WeQ 没有收银台，不能假装送出去了。
 */

import '../../styles/gift-mall.css';

export type GiftItem = {
  giftId: number;
  giftName: string;
  giftDesc?: string;
  desc?: string;
  homepageDesc?: string;
  giftPrice?: number;
  svipDiscount?: number;
  staticPic?: string;
  squareStaticPic?: string;
  backgroundColor?: string;
  vecTags?: string[];
};

/** 接口翻页或切换推荐流时可能重发同一条，首屏和后续页都按礼物 ID 去重。 */
export function uniqueGiftItems(items: GiftItem[]): GiftItem[] {
  const seen = new Set<number>();
  return items.filter((item) => {
    if (seen.has(item.giftId)) return false;
    seen.add(item.giftId);
    return true;
  });
}
