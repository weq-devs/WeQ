# 桌面包体积优化（2026-10-25）

## 实施范围

- 仅在渲染进程使用的 11 个直接依赖移入 `devDependencies`，保留正常 Vite 构建；不再将完整图标库、Markdown/图表依赖和高亮资源重复装入生产 `node_modules`。
- 保留主进程、预加载和独立 worker 的运行依赖，特别是通过 `createRequire` 加载的 `electron-trpc/main`、其 peer 依赖和 React 封面渲染依赖，不能只依靠静态 `import` 搜索判断。
- 生产模块排除 `.map` 和 ExcelJS 的 `dist/` 浏览器构建；Node `lib/`、流式导出、许可证继续保留。
- `afterPack` 在最终签名前移除非目标架构的 Darwin resvg 绑定，不修改日常安装应用。
- 将 Laya 已使用的 `@huggingface/tokenizers@0.2.0` 显式列为桌面运行依赖，使 pnpm 布局下的 worker 资源复制源真实存在；不再复制仅供 ONNX 安装脚本使用的 `adm-zip` / `global-agent`。

不删除 Electron 语言资源，不移除离线功能、字体或装扮素材，不下载识别模型，不将语音的 ONNX Runtime 1.24.4 与 OCR/意图分析的 1.30.0 强行合并。

## 打包规则的实际行为

当前 electron-builder 为 25.1.8。它会先将根级 `files` 转成 FileSet；在平台级再追加纯字符串排除规则，会出现另一组默认匹配器，把源码、截图甚至旧 `release/` 收进新 ASAR。不能拿未经配置归一化的 matcher 单测代替真实打包。

因此架构裁剪放在 `scripts/trim-desktop-package.mjs`，只处理本次 `appOutDir` 下两个明确的 Darwin 绑定目录。单测先执行构建器自身的 `doMergeConfigs`，再调用真实主文件及依赖匹配器，确认源码、预览和旧产物均不入包。

本地打包仍沿用发布流程：先构建，然后运行 `scripts/prepare-electron-builder-manifest.mjs`，临时换入去除 workspace 依赖的发布清单，打包结束必须恢复开发清单。直接使用开发清单打包的既有 workspace 路径问题不属于本轮修复。

## 验证入口

```bash
pnpm --filter @weq/desktop exec vitest run test/package_size.test.ts test/qqmail_bundle.test.ts test/ocr_engine_guard.test.ts test/mac_signing.test.ts test/worker_path.test.ts
pnpm --filter @weq/desktop exec electron-vite build
# 以上述发布清单流程生成本机架构的未发布产物后：
pnpm --filter @weq/desktop exec env ELECTRON_RUN_AS_NODE=1 electron ../../scripts/smoke-desktop-package.mjs /absolute/path/to/weQ.app/Contents/Resources
```

产物冒烟只读取包内模块并在内存中操作黄金样本，不启动应用主入口、账号服务、网络节点或用户资料，不联网下载模型。解析结果必须位于被测 `resources` 内，防止位于仓库内的产物意外回退到开发依赖而假通过。覆盖流式 XLSX、普通 XLSX/CSV、sharp、resvg、satori、ONNX、Laya 和 sherpa 绑定加载。

Intel Mac 沿用现有 ONNX 原生绑定缺失的产品限制，冒烟显式跳过该部分，不能冒称验证了本地推理。

ExcelJS 4.4.0 在本机 Electron 44.9 的 `xlsx.load()` 有既有 `iterable is not async iterable` 错误，旧包同样复现。本轮检查实际使用的流式导出路径，并通过 ZIP 中的工作表 XML 核验输出，不修改该读取能力。

## 验证记录

本机 macOS ARM64 的旧 `2.2.1` 产物与本轮工作区构建对照如下。两者不是同一源码快照，工作区还包含其他在途改动；这里报告实际产物差值，不将差值全部归因于某一项裁剪。

| 口径 | 旧构建 | 本轮构建 | 减少 |
| --- | ---: | ---: | ---: |
| 普通文件逻辑大小（不跟随软链接、不计扩展属性） | 929.31 MiB | 650.59 MiB | 278.72 MiB，约 30.0% |
| `app.asar` | 326.93 MiB | 53.09 MiB | 273.84 MiB，约 83.8% |
| ZIP 流 | 342.34 MiB | 272.39 MiB | 69.95 MiB，约 20.4% |

ZIP 两边使用相同的 `ditto -c -k --sequesterRsrc --keepParent <app> -`，流式计数且保留签名扩展属性，不在 SSD 写入两个完整压缩副本。不是 DMG、NSIS 或 AppImage 的实测值，也不是 APFS 独占物理空间回收量。

桌面与内置 Web 生产构建、桌面 Node/Web 类型检查、针对性回归、包内模块冒烟均通过；`codesign --verify --deep --strict` 通过。本轮产物使用本地 ad-hoc 签名，未公证、未发布、未安装，未触碰日常应用或用户聊天数据库。未执行全量 CI；跨平台规则测试不等同于 Windows/Linux 真机打包验收。

产物位于 `apps/desktop/release/size-optimization-20261025/mac-arm64/weQ.app`；开发清单已恢复。第一轮因平台级 `files` 规则产生的无效大包已清理，不作为验收产物。

## 第二轮：运行库、worker 与主题

- macOS 在每个引擎自己的目录中保留完整版本 ONNX 动态库，仅将内容哈希与大小都一致的兼容名称替换为相对软链接；多版本混放、内容不同或已有链接均不改，不跨引擎合并 1.24.4 与 1.30.0。操作发生在签名前，单测覆盖幂等、异内容和多版本反例。
- `afterPack` 解析实际复制出的 worker 入口及相对导入，保留静态依赖闭包，只删除闭包外的 JS chunks。重导出、静态动态导入、循环及多入口都有覆盖；遇到计算式 `import()`、缺失文件或越界路径时在删除前中止。运行时模型文件路径形式的动态原生 `require` 不参与 JS chunks 裁剪。
- Go 辅助程序使用 `-ldflags="-s -w"` 去掉符号与 DWARF，保留 Go 运行时栈信息所需的数据；这会减少外部调试器可用的信息，调试构建可移除这组参数重新编译。不启动网络节点或修改现有节点身份。
- Shiki 直接导入当前使用的两个主题模块，不再通过全主题注册表引入其余主题；语言集合与浅深主题 token 保持不变。当前版本的导出路径需要 `.mjs` 扩展名，已用实际模块加载验证。
- 生产文件规则排除 `out/types-*` 和 `.d.ts` / `.d.cts` / `.d.mts`，不影响 JS 运行入口。

产物冒烟增加同版本别名检查，以及备份、清除和 macOS 更新 worker 的启动检查。备份输入无效请求，在 schema 阶段退出；清理仅发 prepare 后结束测试子进程；更新输入无效 plan，验证拒绝。不会发送任何 commit、执行清理或安装，也不读取真实聊天数据库。

第二轮使用基线 `3c503870` 的隔离工作区，复用本机依赖缓存、Electron 和已有离线资源，避免共享工作区并行上游合并影响验证。合并结束后已将本轮改动同步回当前分支，并在主工作区通过桌面 Node/Web 类型检查及 32 项相关单测，Go 构建参数另有 2 项离线测试通过。

| 口径 | 第一轮产物 | 第二轮产物 | 额外减少 |
| --- | ---: | ---: | ---: |
| 普通文件逻辑大小 | 650.59 MiB | 556.83 MiB | 93.76 MiB，约 14.4% |
| `app.asar` | 53.09 MiB | 50.29 MiB | 2.80 MiB |
| 保留签名元数据的 ZIP | 272.39 MiB | 241.78 MiB | 30.61 MiB，约 11.2% |
| Go 连接辅助程序 | 28.55 MiB | 19.52 MiB | 9.03 MiB |
| 外置 worker chunks | 5.61 MiB | 0.78 MiB | 4.83 MiB |
| 桌面 + Web 主题 chunks | 2.64 MiB、各 65 个 | 0.046 MiB、各 2 个 | 约 2.60 MiB |

第二轮 `.app` 使用 ad-hoc 签名，严格签名校验通过。ZIP 使用与第一轮相同的 `ditto -c -k --sequesterRsrc --keepParent` 参数，实际生成并解压后再次通过 `codesign --verify --deep --strict` 及全部产物冒烟；其中 ONNX 额外执行了 IR 8 / opset 13 的内存 Identity 黄金模型，语音绑定查询版本，均不下载模型、不读取 QQ 数据。原始 app 与解压 app 中的相对别名都保持有效。

隔离构建最初直接链接了三份外部 `.dat` 素材，严格签名校验拒绝应用外链接。已将这些输入改为本地 APFS 克隆文件后重新打包通过；不要把这种构建输入链接与包内运行库的相对别名混为一谈，也不要关闭严格校验绕过。

相对最初 929.31 MiB 应用、342.34 MiB ZIP，累计减少约 40.1% 和 29.4%。仍是本机 ARM64 构建对照，不代表 Windows/Linux 真机或 Developer ID 公证验收；未运行全量 CI，未安装或发布。

交付位于 `apps/desktop/release/size-optimization-round-two-20261025/`，包含 `mac-arm64/weQ.app` 和 `weQ-size-check-mac-arm64.zip`。这是体积验证构建，不作为新上游合并功能的发布验收。解压验证副本在验后清理。
