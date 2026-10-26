export const AUTHORIZATION_PROTOCOL = 1;

export interface LongTermAuthorizationStatus {
  platform: string;
  state: 'unavailable' | 'not-installed' | 'ready' | 'needs-repair';
  message: string;
  build?: string;
  installedBytes?: number;
}

export interface LongTermAuthorizationBridge {
  status(): Promise<LongTermAuthorizationStatus>;
  install(): Promise<LongTermAuthorizationStatus>;
  remove(): Promise<LongTermAuthorizationStatus>;
}
