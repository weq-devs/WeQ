/**
 * Ark 面板的「位置卡片」tab。
 *
 * 三件事：**搜**（腾讯位置服务输入提示）→ **选**（地图点一下）→ **填**（逆地址
 * 解析给出的省市区 / 地址），三个结果都落到可编辑的输入框里 —— 用户想改成什么
 * 就是什么，面板不写死任何地名。
 *
 * 一个刻意的规则：自动填**不覆盖用户手打的字**。每次自动写入都记下自己写了什么
 * （`autoRef`），下一轮只有「还是我上次写的那句」或「字段是空的」才继续覆盖；
 * 用户一改，这个字段就归用户了。想强制刷新就按「解析地址」。
 *
 * 搜索与逆地址解析都由应用层注入（`ArkLocationProvider`），面板自己不碰网络：
 * 渲染层 CSP 是 `connect-src 'self'`，而且 key 不该落进前端。
 */

/** 位置卡片的四个可编辑字段。 */
export type ArkLocationDraft = {
  /** 详细地址（卡片上那行小字）。 */
  address: string;
  /** 省市区。 */
  region: string;
  latitude: string;
  longitude: string;
};

export function emptyLocationDraft(): ArkLocationDraft {
  return { address: '', region: '', latitude: '', longitude: '' };
}
