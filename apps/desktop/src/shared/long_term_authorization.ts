export { AUTHORIZATION_PROTOCOL } from '@weq/native/authorization.mjs';

export interface LongTermAuthorizationStatus {
  platform: string;
  state: 'unavailable' | 'not-installed' | 'ready' | 'needs-repair';
  message: string;
  build?: string;
  installedBytes?: number;
  development?: boolean;
}

export interface LongTermAuthorizationBridge {
  status(): Promise<LongTermAuthorizationStatus>;
  install(expectedDevelopment?: boolean): Promise<LongTermAuthorizationStatus>;
  remove(expectedDevelopment?: boolean): Promise<LongTermAuthorizationStatus>;
}
