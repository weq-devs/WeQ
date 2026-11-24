export const REMOTE_ACCOUNT_ENTRY = '/_weq/connect';
export const LAST_REMOTE_ACCOUNT_KEY = 'weq.remote-last-account.v1';
export const REMOTE_WORKSPACE_KEY = 'weq.remote-web-startup.v1';

export interface RemoteAccountChoice {
  configId: string;
  displayName: string;
  uin: string;
  static: boolean;
  online: boolean | null;
  avatarUrl: string | null;
}
