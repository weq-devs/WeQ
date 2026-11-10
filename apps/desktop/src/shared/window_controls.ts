export type WindowControlsStyle = 'native' | 'windows';

export function supportsWindowsStyleControls(platform: string): boolean {
  return platform === 'darwin' || platform === 'linux';
}

/** 账号选择始终统一；Windows 不受其它平台的偏好影响。 */
export function windowControlsStyle(
  platform: string,
  windowsStyle: boolean,
  layout: 'home' | 'chat',
): WindowControlsStyle {
  return layout === 'home' || platform === 'win32' || windowsStyle ? 'windows' : 'native';
}
