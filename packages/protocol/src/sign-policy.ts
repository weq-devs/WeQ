/**
 * 签名（`SecSign/SecToken/SecExtra`）策略。
 *
 * `scripts/probe-sign.ts` 的真机实测表明 QQ 的签名集合**按平台不同**：Linux 只给
 * 19 条命令加 `SecInfo`，Windows 会给 42 条。WeQ 借的是同机 QQ 的凭据，所以在哪个
 * 平台就按哪个平台的 QQ 行为发 —— **不能取并集**：Linux 上多发不必要的签名曾触发
 * 风控。
 *
 * 声明方式：
 *   - 三端一致时直接写 `boolean`；
 *   - 平台有差异时写对象，`linux` 必填，`win32` 缺省沿用 `linux`；
 *   - macOS 尚未实测，缺省跟 Windows（`darwin` 未显式声明时回落到 `win32`）。
 *
 * 实测记录见 `docs/develop/sign-policy-20261109.md`。
 */

export type NeedSign =
  | boolean
  | {
      /** Linux 实测结果。 */
      linux: boolean;
      /** Windows 实测结果；缺省沿用 {@link NeedSign} 里的 `linux`。 */
      win32?: boolean;
      /** macOS 实测结果；未测时跟 Windows。 */
      darwin?: boolean;
    };

/** Linux 不签、Windows 签；macOS 实测前先跟 Windows。 */
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
  if (platform === 'win32') return policy.win32 ?? policy.linux;
  // macOS 还没有实测数据，先按 Windows 处理，避免漏签。
  if (platform === 'darwin') return policy.darwin ?? policy.win32 ?? policy.linux;
  return policy.linux;
}
