import { z } from 'zod';

const deviceText = z.string().trim().min(1).max(128);
export const remoteDeviceInfoSchema = z.object({
  platform: z.enum(['ios', 'android']),
  model: deviceText,
  osVersion: deviceText,
  appVersion: deviceText,
  appBuild: deviceText,
});

export type RemoteDeviceInfo = z.infer<typeof remoteDeviceInfoSchema>;
export const remoteConnectionInfoSchema = z.object({
  ip: z.string().max(64),
  route: z.enum(['lan', 'tailscale', 'unknown']),
});
export type RemoteConnectionInfo = z.infer<typeof remoteConnectionInfoSchema>;
export const REMOTE_ACTIVITY_WINDOW = 45_000;
