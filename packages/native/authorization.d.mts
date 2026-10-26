export const AUTHORIZATION_PROTOCOL: 1;
export const AUTHORIZATION_TARGETS: Readonly<Record<string, string>>;
export function authorizationExecutable(platform: string): string;
export interface NativeBuildInfo {
  buildTime?: number | null;
  expireTime?: number | null;
  validitySecs: number;
  isDev: boolean;
}
export interface AuthorizationBuildInfo extends NativeBuildInfo {
  protocol: number;
  target: string;
  capabilities: string[];
  channel?: 'development' | 'release';
}
export function validateNativeBuildInfo(
  info: unknown,
  options?: { production?: boolean; expected?: NativeBuildInfo; now?: number },
): void;
export function validateAuthorizationBuildInfo(
  info: unknown,
  platform: string,
  options?: { production?: boolean; expected?: AuthorizationBuildInfo; now?: number },
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
