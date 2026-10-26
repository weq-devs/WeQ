import { verifyDesktopAuthorization } from './trim-desktop-package.mjs';

// afterSign 的 PackContext 提供真实目标架构；自定义 mac.sign 的 options 并不提供。
export default function verifySignedAuthorization(context) {
  return verifyDesktopAuthorization(context);
}
