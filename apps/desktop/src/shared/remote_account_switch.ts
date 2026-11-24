export interface RemoteAccountChoice {
  configId: string;
  displayName: string;
  uin: string;
  static: boolean;
  online: boolean | null;
  avatarUrl: string | null;
}
