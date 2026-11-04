/**
 * 群通话协议层。
 *
 * 与私聊 `call/` **并列**，不共用状态机：群聊没有 P2P、媒体全走 `0x02`、
 * 成员是集合而不是单个对端（详见仓库根 `todo.md`）。
 *
 * - `signaling.ts` —— `mav_appsvr` 四条信令（开房 / 邀请 / 查询 / 多端同步）
 * - `gcs.ts`       —— `0x28` 控制面（嵌套 head）与会话密钥 k2 下发
 * - `relay.ts`     —— `0x02` 通道：媒体、成员状态、摄像头、麦克风、退出
 */

export * from './signaling';
export * from './gcs';
export * from './relay';
