/**
 * 签名（`SecSign/SecToken/SecExtra`）策略。
 *
 * `scripts/probe-sign.ts` 的真机实测表明 QQ 的签名集合**按平台不同**，而且三端互不
 * 相同（macOS 既不是 Linux 的子集，也不完全等于 Windows）。WeQ 借的是同机 QQ 的
 * 凭据，所以在哪个平台就按哪个平台的 QQ 行为发 —— **不能取并集**：多带不必要的
 * `SecInfo` 曾经触发风控。
 *
 * 声明方式：
 *   - 三端一致时直接写 `boolean`；
 *   - 平台有差异时写对象，`linux` / `win32` / `darwin` **三个都必填**。
 *
 * 早期允许 `darwin` 缺省回落到 `win32`；macOS 实测后（`0x9082_1/2` 不签、
 * `0x11e9_100` 签）证明这个回落会算错，已改成强制三端显式声明。
 *
 * 实测记录见 `docs/develop/sign-policy-20261109.md`。
 */

export type NeedSign =
  | boolean
  | {
      /** Linux 实测结果。 */
      linux: boolean;
      /** Windows 实测结果。 */
      win32: boolean;
      /** macOS 实测结果。 */
      darwin: boolean;
    };

/**
 * Linux 不签、Windows 与 macOS 签。macOS 全量实测里，凡是 Windows 签的都签，
 * 唯二的例外是 `0x9082_1/2`（macOS 不签），那两个 spec 单独声明。
 */
export const SIGN_NON_LINUX: NeedSign = Object.freeze({
  linux: false,
  win32: true,
  darwin: true,
});

/** 把 spec 的跨平台声明解析成当前平台实际要传给 native 的布尔值。 */
export function needSignFor(
  policy: NeedSign,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (typeof policy === 'boolean') return policy;
  if (platform === 'win32') return policy.win32;
  if (platform === 'darwin') return policy.darwin;
  return policy.linux;
}
