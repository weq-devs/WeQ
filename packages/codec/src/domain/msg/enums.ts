/**
 * Message-level enums + the enum-mapping helper used by row_to_message.
 *
 * `ChatType` is vendored from the soon-to-be-deleted `@weq/types` (which is
 * itself vendored from QQ NT). `MsgType` / `SendType` / `SendStatus` live next
 * to the wire schema in `proto/msg/40900.ts` and are imported there.
 */

/**
 * 聊天类型枚举 — value of SQL column 40010.
 * Vendored from QQ NT (KCHATTYPE*).
 */
export enum ChatType {
  KCHATTYPEADELIE = 42, // 机器人？
  /**
   * QQ AI 助手「小Q」的会话（`ai_session_table` / `ai_assistant_msg_table`）。
   * 它**不在** c2c_msg_table 里：会话键是 sessionId（40021），小Q 主入口的
   * sessionId 固定为 `10000`。见 docs/database/nt_msg/ai-assistant.md。
   */
  KCHATTYPEAIASSISTANT = 45,
  KCHATTYPEBUDDYNOTIFY = 5,
  KCHATTYPEC2C = 1, // 好友私聊
  KCHATTYPECIRCLE = 113, // QQ短视频？？
  KCHATTYPEDATALINE = 8, // 数据线（我的电脑/手机/平板）
  KCHATTYPEDATALINEMQQ = 134,
  KCHATTYPEDISC = 3,
  KCHATTYPEFAV = 41,
  KCHATTYPEGAMEMESSAGE = 105, // 游戏消息
  KCHATTYPEGAMEMESSAGEFOLDER = 116, // 游戏中心
  KCHATTYPEGROUP = 2, // 群聊消息
  KCHATTYPEGROUPBLESS = 133,
  KCHATTYPEGROUPGUILD = 9, // 频道群聊?
  KCHATTYPEGROUPHELPER = 7,
  KCHATTYPEGROUPNOTIFY = 6,
  KCHATTYPEGUILD = 4, // 频道私聊?
  KCHATTYPEGUILDMETA = 16, // 频道本身
  KCHATTYPEMATCHFRIEND = 104, // 好友匹配（c2c）
  KCHATTYPEMATCHFRIENDFOLDER = 109, // 好友匹配？（排除）
  KCHATTYPENEARBY = 106, // 附近的人（c2c）
  KCHATTYPENEARBYASSISTANT = 107,
  KCHATTYPENEARBYFOLDER = 110,
  KCHATTYPENEARBYHELLOFOLDER = 112,
  KCHATTYPENEARBYINTERACT = 108,
  KCHATTYPEQQNOTIFY = 132, // QQ通知，例如好友生日
  KCHATTYPERELATEACCOUNT = 131, // QQ 关联账号通知
  KCHATTYPESERVICEASSISTANT = 118, // QQ服务助手（ 会员通知？ ）  （QQ会员  功能内测通知）
  KCHATTYPESERVICEASSISTANTSUB = 201,
  KCHATTYPESQUAREPUBLIC = 115,
  KCHATTYPESUBSCRIBEFOLDER = 30,
  KCHATTYPETEMPADDRESSBOOK = 111,
  KCHATTYPETEMPBUSSINESSCRM = 102,
  KCHATTYPETEMPC2CFROMGROUP = 100, // 群聊发起的临时会话  c2c
  KCHATTYPETEMPC2CFROMUNKNOWN = 99, // 临时会话（未知来源）  c2c
  KCHATTYPETEMPFRIENDVERIFY = 101, // 临时会话（好友验证）  c2c
  KCHATTYPETEMPNEARBYPRO = 119, // 临时会话（附近的人）  c2c
  KCHATTYPETEMPPUBLICACCOUNT = 103, // 公众号通知
  KCHATTYPETEMPWPA = 117,
  KCHATTYPEUNKNOWN = 0,
  KCHATTYPEWEIYUN = 40, // 微云是什么？？
}

/**
 * Reverse-lookup a numeric enum: returns the member NAME when `value` is a
 * defined member, otherwise returns the raw number unchanged. Lets callers
 * surface "MULTI_FORWARD" for known values while still round-tripping unknown
 * ones for later RE.
 */
export function enumName(enumObj: Record<number, string>, value: number): string | number {
  const name = enumObj[value];
  return typeof name === 'string' ? name : value;
}
