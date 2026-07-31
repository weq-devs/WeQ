/**
 * Electron custom-scheme registration for the three media/asset protocols.
 *
 * The handlers themselves live next to their logic (`media_protocol.ts`,
 * `avatar_protocol.ts`, `resource_protocol.ts`) as plain `Request → Response`
 * functions with no Electron imports, so the web app can mount them on HTTP
 * routes. This file is the desktop-only shim that binds them to custom schemes.
 */

import { protocol } from 'electron';
import { MEDIA_SCHEME, handleMediaRequest } from './media_protocol';
import { AVATAR_SCHEME, handleAvatarRequest } from './avatar_protocol';
import { RESOURCE_SCHEME, handleResourceRequest } from './resource_protocol';

export function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, handleMediaRequest);
}

export function registerAvatarProtocol(): void {
  protocol.handle(AVATAR_SCHEME, handleAvatarRequest);
}

export function registerResourceProtocol(): void {
  protocol.handle(RESOURCE_SCHEME, handleResourceRequest);
}
