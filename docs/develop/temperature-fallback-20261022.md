# 模型温度参数回退（2026-10-22）

## 范围

OpenAI 官方[聊天接口说明](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)指出参数支持会随模型变化。这里按真实拒绝响应判断，不维护模型名称黑名单，也不修改用户温度配置或持久化提供方兼容性缓存。

- `packages/agentlab/src/temperature_fallback.ts`：解析明确的不支持参数／仅支持默认温度错误，构造只删除顶层 `temperature` 的 JSON 请求副本。
- `fetchApi`：对 HTTP 400／422 的明确拒绝在读取成功内容前去参回退，返回 `temperatureOmitted`，供助手后续重试沿用当前状态。
- `requestApiJson`：补充 HTTP 200 JSON 业务拒绝的回退，覆盖意图分析、互动画像、推荐回复、克隆聊天与提炼／视觉描述等调用。
- 助手普通 JSON 调用复用 `requestApiJson`，通过 `ApiHttpError` 保留原有 HTTP 分类文案；流式调用兼容 SSE 错误帧或端点返回的普通 JSON 错误。

## 边界

1. 只处理 `/chat/completions` 的 JSON POST，且请求自身包含顶层温度字段。0 也属于已设置，不按真假值判断。不重放 ReadableStream 形式的请求体、其他接口或不可解析输入。
2. 必须明确拒绝温度参数，或明确说明模型仅支持默认温度。其他参数、范围／类型、鉴权、额度／限流、网络失败、取消和超时不触发该回退。
3. 温度回退最多一次；第二次请求不再含温度，后续错误正常传播。模型、地址、鉴权、消息、工具、预算与 AbortSignal 不变，不重置超时。
4. HTTP 拒绝响应仅窥视 64 KiB，过大或不能窥视时保留原错误路径；正常成功请求不额外解析或复制提示词。取消原响应后才发起回退，不保留未消费的失败连接。
5. 流式仅在没有正文、推理和工具片段时可回退；已开始输出时不重发。助手原有 reasoning 与 429 重试各有独立的一次上限，跨温度回退沿用，不重复附上已移除的温度参数。
6. 每个实际 HTTP 尝试独立 requestId，首次拒绝记为 failed，重试成功／失败各自结算。保留每次服务端 usage，不把失败、未知或缺失分项填成零，也不把两次尝试合成一次成功。

## 验证

使用合成 Response／SSE／消息夹具和 fetch 桩，不联网、不读取 QQ 原库：

- `packages/agentlab/test/temperature_fallback.test.ts`：HTTP／业务错误、请求副本、明确识别与负例、有界重试、取消、错误正文上限及账目。
- `packages/service/test/intent_sense.test.ts`：真实分析、画像、推荐路径拿到 API 重试结果，设置值不变，成功缓存不重复请求。
- `packages/service/test/assistant_api_usage.test.ts`：HTTP／SSE／JSON 拒绝、保留 reasoning、部分输出保护、多参数与限流边界、标题功能及物理记账。

这不是对所有提供方错误格式的猜测性兼容；未能明确识别的错误保持失败，不能仅因正文出现 `temperature` 一词就重发。
