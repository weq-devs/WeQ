// Web 共用 bootstrap router，但只有桌面主进程登记窗口更新回调。
let refresh: (() => void) | undefined;
let preference: () => boolean = () => false;

export function registerWindowControlsPreference(read: () => boolean): void {
  preference = read;
}

export function windowDecorationOptions(): { frame?: false } {
  return (process.platform === 'darwin' || process.platform === 'linux') && preference()
    ? { frame: false }
    : {};
}

export function registerWindowControlsRefresh(callback: () => void): void {
  refresh = callback;
}

export function refreshWindowControls(): void {
  refresh?.();
}
