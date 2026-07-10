/**
 * 数据线（跨设备同步）会话的设备身份。
 *
 * `dataline_msg_table` 里，会话/消息的 uid 不是真实好友 uid，而是 QQ NT 固定的
 * 设备伪 uid（我的手机 / 我的电脑 / 我的平板）。`recent_contact_v3_table` 对这类
 * 会话往往不填 `targetDisplayName`，于是前端只能显示原始 uid。这里给出 uid →
 * 设备类型/中文名的映射，供 service 与 renderer 共享，用来：
 *   - 会话标题回退成「我的手机」等可读名；
 *   - 头像按设备类型选图标；
 *   - 消息「是不是我发的」判定：约定 **PC 即本机（自己）**，手机/平板为对端。
 *
 * uid 常量来自 QQ NT（DATALINE_*_UID）。
 */

export type DatalineDevice = 'phone' | 'pc' | 'pad';

/** 设备伪 uid → 设备类型。 */
export const DATALINE_UID_TO_DEVICE: Readonly<Record<string, DatalineDevice>> = {
  'u_Wcc5rknRRqRO8y5gxMD6sA': 'phone',
  'u_rK7NMsbv2ZjEGPdCuOiCfw': 'pc',
  'u_l7jpPIZxQo0mzJwoEt-SKw': 'pad',
};

/** 设备类型 → 中文会话名。 */
export const DATALINE_DEVICE_NAME: Readonly<Record<DatalineDevice, string>> = {
  phone: '我的手机',
  pc: '我的电脑',
  pad: '我的平板',
};

/** 约定为「本机（自己）」的设备——发自它的消息算作我发的。 */
export const DATALINE_SELF_DEVICE: DatalineDevice = 'pc';

/** 该 uid 是否是数据线设备伪 uid。 */
export function isDatalineUid(uid: string): boolean {
  return Object.prototype.hasOwnProperty.call(DATALINE_UID_TO_DEVICE, uid);
}

/** 设备伪 uid → 中文名（未知则返回 null）。 */
export function datalineName(uid: string): string | null {
  const device = DATALINE_UID_TO_DEVICE[uid];
  return device ? DATALINE_DEVICE_NAME[device] : null;
}

/** 设备伪 uid → 设备类型（未知则返回 null）。 */
export function datalineDevice(uid: string): DatalineDevice | null {
  return DATALINE_UID_TO_DEVICE[uid] ?? null;
}

/** 这个数据线 sender uid 是否代表「我」（约定 PC = 本机）。 */
export function isDatalineSelfUid(uid: string): boolean {
  return DATALINE_UID_TO_DEVICE[uid] === DATALINE_SELF_DEVICE;
}
