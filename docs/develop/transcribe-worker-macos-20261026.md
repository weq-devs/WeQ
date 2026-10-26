# macOS 离线语音转写子进程修复（2026-10-26）

## 原因与修复

- 本机旧 `2.2.1` ARM64 产物中，语音引擎从 `app.asar/out/main/` fork，子进程入口解析失败，以 code 1 退出。现复用 `resolveChildWorkerPath()`，与 OCR 一样优先使用 `Resources/out/main/` 的实体入口，缺失时直接报安装包不完整。
- 外置 worker 原先加载 `Resources/node_modules/sherpa-onnx-node`，原生绑定却在 `app.asar.unpacked/node_modules/`，两者不相邻。现将 JS 包也解包，打包态从实体解包目录创建 require 上下文；开发态保留正常依赖解析，不依赖用户的工作目录或系统 Node。
- 解包规则使用 `**/node_modules/sherpa-onnx-node/**/*`，覆盖 pnpm 的实际源路径；单纯的 `node_modules/sherpa-onnx-node/**/*` 在本仓库真实打包时不会解出该包。回归测试调用构建器自身的 matcher，并传入 realpath 后的源文件。
- 主进程保留最多 4096 字符的 stderr 尾部，在 close（而不是 exit）事件后生成诊断，并区分退出码、退出信号和段错误。已有 IPC 错误优先，不被后续退出事件覆盖。
- worker 等待 IPC 发送回调再退出，避免立即 `process.exit()` 截断错误或结果。

## 回归入口

```bash
pnpm --filter @weq/desktop exec vitest run test/transcribe_engine.test.ts test/transcribe_worker.test.ts test/worker_path.test.ts test/package_size.test.ts
pnpm --filter @weq/desktop typecheck:node
```

子进程用例在隔离目录使用独立的 sherpa JS 夹具，验证实际加载了该夹具、成功和加载失败的 IPC 均能送达；失败包含 256 KB 内容，校验尾部送达，覆盖 IPC 背压。清空 NODE_PATH，避免开发依赖回退造成假通过。包路径测试覆盖 asar 拒绝及真实 extraResources 优先。

`scripts/smoke-desktop-package.mjs` 新增实体转写 worker 探测：先加载真实原生绑定，再发送空 WAV，验证 IPC 往返。不下载模型、不做真实语音识别、不访问 QQ 数据库。

## 验证边界

- 四个针对性测试文件共 29 项通过，改动文件的 Biome 检查通过。
- 桌面主进程类型检查通过。
- 独立主进程生产构建通过；macOS ARM64 验证包完成本地 ad-hoc 签名及严格签名校验，包内完整冒烟通过，包含实体转写 worker 的真实原生绑定加载和 IPC 往返。
- 完整 `electron-vite build` 被当前工作区另一路 Web 构建问题阻断：`packages/agentlab/src/sticker.ts` 的 `node:fs` 导入进入浏览器产物。未修改该部分，也不把独立主进程构建当作完整构建通过。
- 默认打包的 native rebuild 被现有 pnpm 依赖中缺少 `@radix-ui/react-compose-refs` 路径阻断；本次验证包复用已安装的原生模块，以 `npmRebuild: false` 检查打包布局，不据此声称 rebuild 已修复。
- 验证包使用独立构建的当前主进程、既有前端产物，仅用于本地打包与加载检查，不作为正式发布或对方机器的验收。开发清单在打包后恢复，未推送、发布或安装。
- 首次验证签名自动选中本机证书，已主动中止并改用 ad-hoc。仅用于检查的 `release/transcribe-verification-20261026/` 产物验后清理，不影响既有构建。
- 未验证 Intel Mac、Windows、Linux 的真实安装包，也未验证真实模型推理准确率；配置测试不替代这些平台实测。
