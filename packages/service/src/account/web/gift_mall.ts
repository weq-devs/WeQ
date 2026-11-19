/**
 * 已收编进 `@weqbot/protocol/web`（kernel 侧分两个文件：`gift-mall.ts` 是请求
 * 构造，`gift-mall-exec.ts` 是执行层）。
 *
 * WeQ 这边只保留转发，**不要再加业务逻辑**。改逻辑请改 kernel。
 */
export * from '@weqbot/protocol';
