import type { RemoteConnectionInfo, RemoteDeviceInfo } from './remote_device';

export const REMOTE_ACCOUNT_ENTRY = '/_weq/connect';
export const REMOTE_ACCOUNT_ACCESS = '/_weq/request-account-access';
export const LAST_REMOTE_ACCOUNT_KEY = 'weq.remote-last-account.v1';
export const REMOTE_WORKSPACE_KEY = 'weq.remote-web-startup.v1';

export interface RemoteAccountSummary {
  configId: string;
  displayName: string;
  uin: string;
  static: boolean;
}

export interface RemoteAccountChoice extends RemoteAccountSummary {
  authorized: boolean;
  online: boolean | null;
  avatarUrl: string | null;
}

export interface RemoteAccountAccessRequest {
  id: string;
  account: RemoteAccountSummary;
  device: {
    id: string;
    name: string;
    lastSeenAt: number | null;
    deviceInfo?: RemoteDeviceInfo;
    lastConnection?: RemoteConnectionInfo;
  };
}

export type RemoteAccountAccessResult =
  | { state: 'pending'; id: string }
  | { state: 'approved' | 'denied' | 'expired' };
