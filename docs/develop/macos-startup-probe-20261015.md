# macOS QQ 进程探测

## 为什么不用同步全进程扫描

macOS 的 native 数据库持有者扫描会同步遍历进程并调用 `proc_pidfdinfo`；内核检查慢时可阻塞 Electron 主线程，让“账号已打开但界面无资料”看起来像渲染故障。常规账号监控使用异步探测，显式数据库修复的完整持有者检查不因此替换。

## 归属判定

- `Platform.resolveQqPidAsync` 先执行 `pgrep -x QQ`，再对候选 PID 使用 `lsof -nP -a -p <candidates> -F0pcn -- <canonical-db-path>`；不用 shell，也不扫描所有进程的文件。
- 必须同时匹配 QQ 进程名和规范数据库路径；仅名字、WAL 路径或多个候选不能确认唯一归属。
- 探测有总超时和输出上限；超时只终止自己启动的子进程。未退出的子进程仍登记，避免轮询堆积；相同目标的并发探测共用 promise。
- 异步返回后复核账号代次，停止/切号后不能复活旧会话。其它平台可保留同步 resolver 兼容路径。

实现及离线回归见 `packages/platform` 的 macOS resolver/子进程管理，以及 service 的账号监控测试。更新此路径需重新加载主进程；renderer HMR 不能解除已经进入的同步 native 调用。
