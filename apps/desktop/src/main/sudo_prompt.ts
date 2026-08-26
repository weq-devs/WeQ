/**
 * Electron-free seam for the sudo password dialog (Linux 自绘提权框).
 *
 * Linux 提权统一走 `sudo -S`，密码必须由渲染层自绘密码框输入。用户主动发起
 * 的提权（设置页安装/还原 NineBird、登录页自动安装）沿用 macOS 姿势：渲染层
 * 先 `promptPassword` 再带密码调 tRPC mutation，不经过本 seam。但有些提权是
 * 主进程内部发起的（后台 monitor 注入被 yama 拒绝后提权、登录拉起 QQ 前发现
 * 旧版自删 stub 需要迁移），这类场景走本 seam：桌面端由 `elevation_ipc.ts`
 * 在启动时注入真实实现（渲染层弹密码框）；headless web server 不注入任何
 * 实现，`requestSudoPassword` 退化为 null（取消）——web 预期以 root 运行，
 * root 根本不需要提权。
 */

export type SudoPasswordPrompt = (title: string, message: string) => Promise<string | null>;

let current: SudoPasswordPrompt | null = null;

/** 注册桌面实现（见 `elevation_ipc.ts`）。 */
export function setSudoPasswordPrompt(prompt: SudoPasswordPrompt | null): void {
  current = prompt;
}

/** 已注册的实现；headless 宿主为 null。 */
export function getSudoPasswordPrompt(): SudoPasswordPrompt | null {
  return current;
}

/**
 * 请求渲染层弹密码框并等待输入。返回密码；取消 / 无已注册实现（headless）
 * 返回 null。并发调用会合并到同一个对话框、共享同一个答案。
 */
export function requestSudoPassword(title: string, message: string): Promise<string | null> {
  const prompt = current;
  return prompt ? prompt(title, message) : Promise.resolve(null);
}
