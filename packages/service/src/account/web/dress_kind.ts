/**
 * QQ 会员装扮的 appId → 类别映射,好友装扮页(SSR)和自己装扮(trpc)共用。
 *
 * 名字取自装扮页的 business-name / tab 文案。appId 8 目前枚举不到(接口回空),
 * 保留未映射 —— 走 `appId=<n>` 兜底,别瞎猜。
 */
const APP_KIND: Record<number, string> = {
  2: '气泡',
  3: '主题',
  4: '挂件',
  5: '聊天字体',
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
