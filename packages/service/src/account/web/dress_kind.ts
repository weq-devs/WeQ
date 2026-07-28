/**
 * QQ 会员装扮的 appId → 类别映射,好友装扮页(SSR)和自己装扮(trpc)共用。
 *
 * 名字取自装扮页的 business-name / tab 文案。
 *
 * appId 8 = 聊天背景:早先枚举不到是因为当时账号没设背景,接口那一桶回空,不是接口不支持。
 * 设了背景后 `apps["8"]` 就有真值(实测 name="线条咪咪")。它的资源 URL 有个坑:
 * **路径段不一定是 itemId**。实测本账号 itemId=67066,但 img 里的路径段是
 * `462bb8fde2dec534`(hash),`chatBg/item/67066/...` 是 404 —— 另有一些背景的路径段
 * 就是纯数字 id。所以别拿 itemId 拼 URL,一律从 img 抠目录段换文件名
 * (见 self_dress.ts 的 chatBgUrls)。
 */
const APP_KIND: Record<number, string> = {
  2: '气泡',
  3: '主题',
  4: '挂件',
  5: '聊天字体',
  8: '聊天背景',
  15: '名片',
  17: '来电',
  20: '点赞特效',
  22: '浮屏',
  23: '头像',
  26: '进群特效',
  37: '来电铃声',
  47: '头像双击动作',
  305: '界面字体',
  352: '输入状态',
};

/** 人类可读类别;未知 appId 回落到 `appId=<n>`。 */
export function dressKind(appId: number): string {
  return APP_KIND[appId] ?? `appId=${appId}`;
}
