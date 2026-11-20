/**
 * 已收编进 `@weqbot/protocol/web`（kernel 侧文件名 `qzone_public.ts`）。
 *
 * kernel 版是 WeQ 版的**超集**（多出 `getQzoneMsgDetail` / `getQzoneHomeFeeds` /
 * `getQzoneFeedDetail` / `getQzoneShareArk` 等）。这边只保留转发，
 * **不要再加业务逻辑**。改逻辑请改 kernel。
 */
export * from '@weqbot/protocol';
