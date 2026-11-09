# 开发控制台日志

桌面未打包运行、独立 Web 非 production 运行时，公共 logger 同时输出到启动终端。
正式运行默认不新增镜像。原有文件日志格式和内存诊断文件不变；这不是全仓 `console.*`
或 nt_helper 日志的接管。

## 配置

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `WEQ_LOG_CONSOLE` | 开发 `1`，正式 `0` | `0` 关闭、`1` 显式开启终端输出 |
| `WEQ_LOG_LEVEL` | `info` | 终端最低级别：`debug` / `info` / `warn` / `error` |
| `WEQ_LOG_SCOPES` | 空 | 逗号分隔的精确模块名；只过滤 INFO / DEBUG，WARN / ERROR 不受模块过滤 |
| `NO_COLOR` | 未设置 | 存在时关闭颜色；非 TTY 输出也不带颜色 |

```bash
pnpm dev
WEQ_LOG_LEVEL=debug WEQ_LOG_SCOPES=trpc,media-download,database pnpm dev
WEQ_LOG_CONSOLE=0 pnpm dev
```

默认 INFO 聚焦启动、账号、连接变化、媒体汇总和服务状态，不镜像其他模块全部历史 INFO。
指定模块或使用 DEBUG 级别可查看其他模块的现有日志；WARN / ERROR 仍遵循最低级别。
配置错误回落对应默认值，并提示一次。

## 如何阅读

终端每条记录包含北京时间（`+08:00`，毫秒）、级别、进程及 PID、模块和结构化字段。
文件仍保留原始 ISO 时间格式。终端展示会隐藏凭据字段、移除 URL 查询和片段、限制字段
长度及嵌套深度，不展开正文、原始响应及二进制；不修改业务原对象。

- 启动显示应用版本、运行模式、平台、架构、原生加载结果和日志目录。原生接口只提供构建信息时显示构建信息，版本明确为 `unknown`，不拿 pinned 版本冒充实载版本。
- tRPC query/mutation 超过 1 秒会告警；普通成功调用为 DEBUG。订阅不按存活时间判慢。请求 ID 使用 `operationId`，只存在于日志上下文，不进入业务返回值；嵌套 MCP、账号和 tRPC 操作沿用它。
- 参数校验、未登录、预期拒绝与取消为 DEBUG；最终请求失败为 ERROR。同一异常在共用入口和 HTTP/WS 回调之间不重复打印堆栈，传输层独有错误仍会上报。
- 媒体命中缓存、逐图成功和单次尝试为 DEBUG；成功路径按来源每 5 秒汇总次数、失败数、累计耗时。最终失败包含媒体散列标识和各阶段原因计数，不打印 fileToken 或 rkey。禁止在线请求或运行态失活不作为最终失败告警。
- 数据库 `jsQueueWaitMs` 和 `nativePromiseAwaitMs` 任一达到 500 毫秒会报告，两者独立计量。后者包含原生异步等待，**不是纯 SQL 执行耗时**。不开 `WEQ_DATABASE_DIAGNOSTICS` 也能报告，完整查询指纹和调用点仍由原开关控制。
- 主应用开发版的未处理异常与 Promise rejection 通过显式日志桥接上报；不全量转发 DevTools console。渲染进程异常退出沿用现有恢复入口记录。

重复 WARN / ERROR 首次完整输出，同模块、事件、关联对象与错误的后续记录在 30 秒内
聚合次数。聚合表最多 512 项，正常退出刷新；文件端不聚合。不同请求的操作 ID 不会
阻止同一错误聚合，汇总保留首次关联信息。内存、DOM 和动画等连续采样继续单独落盘。

独立 Web 首次启动展示临时访问令牌的专用入口保持不变，不通过通用 logger 落盘。
Web 浏览器没有桌面日志桥接时，前端异常仍在浏览器 DevTools 查看。
