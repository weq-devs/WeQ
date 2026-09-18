/**
 * 「把这张分析卡片存成长图」的渲染端入口（群聊 / 私聊 / 成员共用）。
 *
 * 抓图这件事整个搬到了主进程：它开一个**从不显示**的窗口，用同一个入口把卡片重新
 * 渲染一遍（宽度按长图口径 840px 铺开），把窗口内容区调成卡片尺寸后 `capturePage`
 * 一次拍全，再在用户窗口上弹保存框。
 *
 * 为什么不在用户窗口里拍：拍「视口之外」时 Chromium 会把页面的布局视口临时改成截图
 * 矩形的大小再渲那一块，这一帧照样会被合成到真实窗口上 —— 用户就会看到整个界面闪一下
 * （实测：抓帧的那两帧里页面宽度从 780px 变成了 clip 的 400px）。窗口从不显示之后，
 * 这件事从根上不存在了；顺带连滚动条、拼缝、旧帧、单轴高度上限也一起没了。
 *
 * 所以这里只剩下「把数据递过去」：渲染端完全不做像素处理。
 */

import type {
  AnalyticsExportPayload,
  AnalyticsExportResult,
} from '../../../shared/analytics_export';

type ExportBridge = {
  render(payload: AnalyticsExportPayload): Promise<AnalyticsExportResult>;
};

function bridge(): ExportBridge | undefined {
  return (window as { weq?: { analyticsShot?: ExportBridge } }).weq?.analyticsShot;
}

/**
 * 交给主进程去渲染 + 抓图 + 保存。返回 `{ saved }` / `{ canceled }` / `{ error }`，
 * 调用方只管弹提示，不需要知道中间发生了什么。
 */
export async function exportAnalyticsCard(
  payload: AnalyticsExportPayload,
): Promise<AnalyticsExportResult> {
  const api = bridge();
  if (!api) return { saved: false, error: '当前环境不支持保存图片' };
  try {
    return await api.render(payload);
  } catch (error) {
    return { saved: false, error: error instanceof Error ? error.message : String(error) };
  }
}
