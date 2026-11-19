/**
 * 已收编进 `@weqbot/protocol/web`（kernel 侧文件名 `vip-info.ts`）。
 *
 * **具名导出**而不是 `export *`：kernel 也导出了 `VipInfo` / `VipTier`，而 WeQ 的
 * 会员身份定义在 `../vip`（同一形状，但那是 WeQ 的领域类型）。两边同名会把
 * `../vip` 的导出盖掉，所以这里只转发函数与只读的 wire 类型。
 */
export {
  fetchVipInfo,
  normalizeVipPayload,
  parseExpireTime,
  type RawVipUserInfo,
} from '@weqbot/protocol';
