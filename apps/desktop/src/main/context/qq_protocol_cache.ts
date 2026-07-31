/**
 * Cache for the exe the OS associates with QQ's `tencent://` URL scheme, so the
 * win32 platform can anchor every install path (QQ.exe / wrapper.node /
 * version) on it instead of the `Uninstall\QQ` registry key — which is missing
 * or relocated for portable installs, non-standard layouts, and machines whose
 * registry has been cleaned.
 *
 * Only the cache lives here. The probe that fills it needs Electron's
 * `app.getApplicationInfoForProtocol` and therefore sits in `qq_protocol.ts`,
 * which only the desktop shell imports — this module stays Electron-free so
 * `app_context` (and through it the web app) can depend on it.
 */

let cachedExe: string | null = null;

/** The resolved protocol-handler exe path, or null until/unless a probe finds one. */
export function getQqProtocolExe(): string | null {
  return cachedExe;
}

export function setQqProtocolExe(path: string | null): void {
  cachedExe = path;
}
