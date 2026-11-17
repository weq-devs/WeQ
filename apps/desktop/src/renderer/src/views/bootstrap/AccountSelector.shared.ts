import type { UiAccount } from './types';
import '../../styles/startup-account.css';

export function accountSource(account: UiAccount): string {
  return account.mobile ? '手机备份' : account.static ? '本地备份' : '本机 QQ';
}
