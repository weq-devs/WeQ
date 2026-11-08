export const AUTHORIZATION_PROTOCOL: 2;
export const AUTHORIZATION_INTERFACE: 1;
export const AUTHORIZATION_TARGETS: Readonly<Record<string, string>>;
export function authorizationExecutable(platform: string): string;
export interface NativeBuildInfo {
  buildTime?: number | null;
  expireTime?: number | null;
  validitySecs: number;
  isDev: boolean;
  authorizationInterface?: number;
}
export interface AuthorizationBuildInfo extends NativeBuildInfo {
  protocol: number;
  interface: number;
  target: string;
  capabilities: string[];
  channel?: 'development' | 'release';
}
export type AuthorizationManifestBuildInfo = Omit<AuthorizationBuildInfo, 'interface'> & {
  interface?: number;
};
export function validateAuthorizationContract(
  nativeInfo: NativeBuildInfo | null | undefined,
  helperInfo: AuthorizationBuildInfo | null | undefined,
  options?: { required?: boolean },
): void;
export function validateNativeBuildInfo(
  info: unknown,
  options?: { production?: boolean; expected?: NativeBuildInfo; now?: number },
): void;
export function validateAuthorizationBuildInfo(
  info: unknown,
  platform: string,
  options?: { production?: boolean; expected?: AuthorizationManifestBuildInfo; now?: number },
): void;
export function authorizationArtifact(
  manifest: unknown,
  platform: string,
  directory: string,
  options?: { required?: boolean },
): {
  label: string;
  path: string;
  asset: string;
  sha256: string;
  size: number;
  executable: true;
} | null;
