# Web 外置运行依赖

仅作为 Web 分发的冻结依赖清单，不提供业务代码。打包使用当前仓库锁定的 pnpm，通过
`pnpm deploy --prod --offline --frozen-lockfile --ignore-scripts --node-linker=hoisted`
生成自包含依赖目录。版本调整必须同步根锁文件，并验证当前平台原生绑定和 QuickJS WASM。

桌面与 Web 的依赖可有不同声明范围，但分发根依赖的实际锁定版本必须一致；不得在 dist 中重新解析范围。
