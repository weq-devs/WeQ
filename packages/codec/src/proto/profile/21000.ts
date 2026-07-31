/**
 * 21000 — Column in profile_info_v6 table.
 *
 * QQ 资料扩展信息(VIP/特权、好友互动标识、教育经历、所在地、兴趣标签、QQ空间相册)。
 * 只声明我们透传给前端会用到的字段；其余大量隐私开关 bool 一律省略。
 *
 * 结构(仅保留有价值分支):
 *   #21000
 *     #22003 互动标识列表(pat/spray/friend_tree…)
 *       #31000 (repeated)
 *         #31002 markId    互动标识种类ID(按类型固定, 非用户等级)
 *         #31015 smallIcon 小图标 URL(文件名首段=视觉等级)
 *         #31019 iconTpl   图标 URL 模板 {level}_{sub}_{style}_{size}
 *         #31024 type      类型名(pat/spray/…)
 *     #22004 特权
 *       #20059
 *         #20431 entryUrl  特权页入口(本人 index / 他人 guestprivilege)
 *         #20432 (repeated) 已开通特权项
 *         #20433 (repeated) 未开通特权项
 *           #20441 jumpUrl 跳转 URL
 *           #20442/#20444 iconUrl 图标(gray_N 灰=未开 / big_light_N 亮=已开)
 *           #20447 bizId   特权业务ID(超会=1, 音乐=103, 情侣=119…)
 *           #20448 level   等级(与图标 big_light_N 一致)
 *     #22005 扩展资料
 *       #20018 constellation 星座(1..12, 由生日算出的冗余值)
 *       #20019 zodiac        生肖(1..12)
 *       #20020 bloodType     血型(0=未填)
 *       #20022 occupation    职业(0=未填)
 *       #20023 degree     学历
 *       #20026 school     教育经历/学校
 *       #20027 country    国家
 *       #20028 province   省份
 *       #20029 zip        邮编(自由文本)
 *       #20030 address    详细地址(自由文本)
 *       #20036 city       城市
 *       #20041
 *         #20410 interest  兴趣标签(repeated)
 *       #20039 —— 老版「个人档案」，**不是 protobuf**，是 [u16 tag][u16 len][utf8] TLV，
 *                 装着手机/电脑/相机/汽车机型等 2008 年代的问卷答案。详见
 *                 docs/database/profile_info/profile-info-v6.md 第八节。
 *     #22009 QQ空间相册
 *       #20066
 *         #20461 (repeated) 每张照片
 *           #20471 photoId  照片 hash
 *           #20472 time     拍摄/上传时间(秒)
 *           #20473 (repeated) 尺寸变体
 *             #20481 size   档位(1=原图,2=640,3=160,4=100)
 *             #20482 url    完整可访问 URL
 */

import { ProtoField, ScalarType } from '../../core';

/** #22003/#31000 —— 单个好友互动标识。 */
export const InteractMarkWire = {
  /** #31002: 互动标识种类ID(按类型固定, e.g. pat=44, spray=75)。 */
  markId: ProtoField(31002, ScalarType.INT32, { optional: true }),
  /** #31015: 小图标 URL(文件名首段即视觉等级)。 */
  smallIcon: ProtoField(31015, ScalarType.STRING, { optional: true }),
  /** #31019: 图标 URL 模板 {level}_{sub_level}_{style}_{size}。 */
  iconTemplate: ProtoField(31019, ScalarType.STRING, { optional: true }),
  /** #31024: 类型名(pat/spray/friend_tree/fire/…)。 */
  type: ProtoField(31024, ScalarType.STRING, { optional: true }),
};

export const InteractMarkGroupWire = {
  /** #31000: 互动标识本体(repeated)。 */
  marks: ProtoField(31000, () => InteractMarkWire, { repeat: true }),
};

/** #22004/#20059/#20432|#20433 —— 单项特权。 */
export const PrivilegeItemWire = {
  /** #20441: 跳转 URL。 */
  jumpUrl: ProtoField(20441, ScalarType.STRING, { optional: true }),
  /** #20442: 图标 URL(备用位, 部分特权用这个)。 */
  iconUrlAlt: ProtoField(20442, ScalarType.STRING, { optional: true }),
  /** #20444: 图标 URL(主位, gray_N=未开通 / big_light_N=已开通等级)。 */
  iconUrl: ProtoField(20444, ScalarType.STRING, { optional: true }),
  /** #20447: 特权业务ID(超会=1, 音乐SVIP=103, 情侣=119…)。 */
  bizId: ProtoField(20447, ScalarType.INT32, { optional: true }),
  /** #20448: 等级(与图标 big_light_N 一致)。 */
  level: ProtoField(20448, ScalarType.INT32, { optional: true }),
};

/** #22004/#20059 —— 特权容器。 */
export const PrivilegeContainerWire = {
  /** #20431: 特权页入口 URL。 */
  entryUrl: ProtoField(20431, ScalarType.STRING, { optional: true }),
  /** #20432: 已开通特权(repeated)。 */
  opened: ProtoField(20432, () => PrivilegeItemWire, { repeat: true }),
  /** #20433: 未开通特权(repeated)。 */
  unopened: ProtoField(20433, () => PrivilegeItemWire, { repeat: true }),
};

export const PrivilegeGroupWire = {
  /** #20059: 特权容器。 */
  container: ProtoField(20059, () => PrivilegeContainerWire, { optional: true }),
};

/** #22005/#20041 —— 兴趣标签容器。 */
export const InterestGroupWire = {
  /** #20410: 兴趣标签(repeated)。 */
  tags: ProtoField(20410, ScalarType.STRING, { repeat: true }),
};

/** #22005 —— 扩展资料(教育/所在地/兴趣)。 */
export const ExtInfoWire = {
  /** #20018: 星座(1..12 = 水瓶/双鱼/白羊/金牛/双子/巨蟹/狮子/处女/天秤/天蝎/射手/摩羯)。 */
  constellation: ProtoField(20018, ScalarType.INT32, { optional: true }),
  /** #20019: 生肖(1..12 = 鼠/牛/虎/兔/龙/蛇/马/羊/猴/鸡/狗/猪)。 */
  zodiac: ProtoField(20019, ScalarType.INT32, { optional: true }),
  /** #20020: 血型(0=未填)。 */
  bloodType: ProtoField(20020, ScalarType.INT32, { optional: true }),
  /** #20022: 职业(0=未填)。 */
  occupation: ProtoField(20022, ScalarType.INT32, { optional: true }),
  /** #20023: 学历(如 "初二中级")。 */
  degree: ProtoField(20023, ScalarType.STRING, { optional: true }),
  /** #20026: 教育经历/学校。 */
  school: ProtoField(20026, ScalarType.STRING, { optional: true }),
  /** #20027: 国家。 */
  country: ProtoField(20027, ScalarType.STRING, { optional: true }),
  /** #20028: 省份。 */
  province: ProtoField(20028, ScalarType.STRING, { optional: true }),
  /** #20029: 邮编(自由文本, 有人填"看地址")。 */
  zip: ProtoField(20029, ScalarType.STRING, { optional: true }),
  /** #20030: 详细地址(自由文本)。 */
  address: ProtoField(20030, ScalarType.STRING, { optional: true }),
  /** #20036: 城市。 */
  city: ProtoField(20036, ScalarType.STRING, { optional: true }),
  /** #20041: 兴趣标签容器。 */
  interests: ProtoField(20041, () => InterestGroupWire, { optional: true }),
};

/** #22009/#20066/#20461/#20473 —— 相册照片尺寸变体。 */
export const AlbumPhotoSizeWire = {
  /** #20481: 尺寸档位(1=原图,2=640,3=160,4=100)。 */
  size: ProtoField(20481, ScalarType.INT32, { optional: true }),
  /** #20482: 完整可访问 URL。 */
  url: ProtoField(20482, ScalarType.STRING, { optional: true }),
};

/** #22009/#20066/#20461 —— 单张相册照片。 */
export const AlbumPhotoWire = {
  /** #20471: 照片 hash。 */
  photoId: ProtoField(20471, ScalarType.STRING, { optional: true }),
  /** #20472: 时间(秒)。 */
  time: ProtoField(20472, ScalarType.INT32, { optional: true }),
  /** #20473: 尺寸变体(repeated)。 */
  sizes: ProtoField(20473, () => AlbumPhotoSizeWire, { repeat: true }),
};

/** #22009/#20066 —— 相册容器。 */
export const AlbumContainerWire = {
  /** #20461: 相册照片(repeated)。 */
  photos: ProtoField(20461, () => AlbumPhotoWire, { repeat: true }),
};

export const AlbumGroupWire = {
  /** #20066: 相册容器。 */
  container: ProtoField(20066, () => AlbumContainerWire, { optional: true }),
};

/** #21000 内层各分块。 */
export const ProfileExtInnerWire = {
  /** #22003: 好友互动标识。 */
  interactMarks: ProtoField(22003, () => InteractMarkGroupWire, { optional: true }),
  /** #22004: VIP/特权。 */
  privilege: ProtoField(22004, () => PrivilegeGroupWire, { optional: true }),
  /** #22005: 扩展资料(教育/所在地/兴趣)。 */
  extInfo: ProtoField(22005, () => ExtInfoWire, { optional: true }),
  /** #22009: QQ空间相册。 */
  album: ProtoField(22009, () => AlbumGroupWire, { optional: true }),
};

export const ProfileExtBody = {
  /** #21000: 外层 wrapper。 */
  ext: ProtoField(21000, () => ProfileExtInnerWire, { optional: true }),
};
