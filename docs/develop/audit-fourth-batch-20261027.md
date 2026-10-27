# 审计第四批修复（2026-10-27）

范围为 F10（发布公开时机）与 F15（Web 分发运行依赖漂移），不是实际发布或客户端安装。
F02 截图网络策略、F12 依赖公告可达性、F14 主视图分拆不在本批完成范围。

## F10：草稿至公开

Release 工作流按以下阶段运行：

1. gate 抓取 main/dev，核对标签与检出提交，在上传前固定分类与提交 SHA。
2. checks 调用现有 CI workflow，执行原有 lint、format、typecheck、单测及 Web 冒烟；CI 增加 workflow_call 入口。
3. prepare 在检查成功后创建或校验同标签草稿，分类、远端标签实际提交和 Release ID 必须匹配。
4. Windows、Linux 双架构、macOS 双架构及 Web 矩阵继续按原链路构建、检查并上传；说明仍来自 CHANGELOG。
5. publish 直接依赖所有检查、产物、macOS 更新清单合并和说明，核对远端标签及完整产物后统一公开。
6. QQ 通知只依赖最终公开成功，继续使用第一批固定的 Action SHA。

分类规则明确为：main 可达优先正式，dev 独有提交为测试；显式预发行后缀仍为测试。
两条分支共享历史不能反推出标签创建时的分支，本实现不冒称能还原该来源，而是使用确定的优先规则。
不属于 main/dev、无法读取分支、标签与检出不匹配均拒绝猜测类型。版本输入与 set-version 共用原有输入契约，
不另实现 SemVer 排序。后续阶段使用 gate 的冻结结果，不随分支后来移动重新分类。
仅 gate 为祖先关系抓取完整历史；prepare、notes、publish 使用浅检出，避免重复下载历史。
核对了 [checkout v4 的标签 refspec 实现](https://github.com/actions/checkout/blob/v4/src/ref-helper.ts)，浅检出仍保留当前标签至提交的映射。

electron-builder 配置及 EP_DRAFT 同时限定只上传草稿。已有公开 Release 不接受 prepare 覆盖；
旧草稿仅在当前标签仍指向本次冻结提交、类型匹配时继续，之后仍需本次工作流的全部构建门禁，
不据此推断历史资产的来源。发布按标签串行，避免两个同标签工作流互相竞争。
最后检查 18 项必需产物，包括五平台 Web、桌面安装与更新所需文件；所有上传必须完成且大小为正整数。
Linux AppImage 的 x86_64 与 tar 的 x64 命名差异用实际 builder 宏展开规则独立验证。
远端轻量/附注标签在公开前重新剥离核对 SHA，不能只信 target_commitish 元数据。
GitHub 明确规定现有标签下 target_commitish 不用于创建标签，因此既不将它误当作提交证据，也不因它保存了分支名而拒绝正确草稿。

仅最终 PATCH 把 draft 置 false；测试版不设 latest，正式版用 GitHub legacy 的日期及语义版本选择规则。
校验前失败不会由本工作流公开；PATCH 后的网络错误可能是“已公开但回执丢失”，不能冒称已回滚。
重跑按同一 ID 重新核对分类、标签和产物，已正确公开时不盲目重放 PATCH。
这些门禁不阻止拥有仓库写权限的人在流程外手动修改标签、草稿或资产，也不等于验证了所有平台的安装体验。

依据：[GitHub Releases API](https://docs.github.com/en/rest/releases/releases?apiVersion=2022-11-28)、
[electron-builder GitHub 发布配置](https://www.electron.build/docs/api/builder-util-runtime.interface.githuboptions/)。
另核对本机锁定的 electron-publish 25 系列源码：draft 上传不会自动转公开，EP_DRAFT 优先于发布类型配置。

## F15：运行依赖冻结

新增私有 `@weq/web-runtime`，仅声明 ws、resvg、sharp、QuickJS 四个外置模块；不提供业务代码。
本轮根锁文件仅增加 15 行 importer，没有更新第三方包版本或重新解析现有依赖。
运行根版本和 peer 上下文必须与桌面冻结记录相同，完整传递树与 integrity 来自根锁文件。

pnpm 12.8.1 deploy 使用 prod、offline、frozen-lockfile、ignore-scripts 和 hoisted 布局，
不复制全工作区，也不在 dist 中二次 npm install。缺缓存明确失败，不临时选择新版本。
复用已有 YAML 解析器读取多文档锁文件，校验部署包完整性与依赖边未偏离源记录。
实际测试发现 deploy 未保留包管理器锁段；补齐该段并保留 pnpm 12 要求的显式首文档标记，
再用真正的 frozen 修复安装 dry-run 验证，避免只生成“语法合法但 pnpm 不接受”的锁文件。

每次部署在暂存目录验证 sharp、resvg 原生运算与 QuickJS WASM，再替换生成依赖目录。
原生探针使用短命子进程，避免 Windows DLL 加载后锁住待移动目录。普通提交失败恢复旧生成目录及小型清单；
不承诺任意断电时的多文件事务，但 pack 会拒绝不完整元数据，不会把未验证目录当成可发布产物。
本机安装状态与绝对路径不随包发布，保留独立 pnpm-lock.yaml 及 runtime-deps.json，记录源锁/部署锁摘要、平台与根依赖。

正常包仍预装依赖，离线启动只需要 Node。删掉 node_modules 后，启动器用 npx 引导锁定版本的 pnpm 执行冻结修复，
保留原有“可补回依赖”的能力，不要求用户手工解析版本；修复时缺工具或包缓存仍需要网络。
pnpm 的自包含部署与源码依据见 [pnpm deploy](https://pnpm.io/cli/deploy)。
此处保证的是运行依赖锁树，不承诺所有压缩包逐字节相同；原生组件获取、签名、时间戳和平台构建仍有各自输入。

## 验证与未验收

本轮先用失败回归确认：默认配置直接公开、缺最终公开门禁、Web 构建后 npm 二次解析，随后修复。
所有 GitHub 状态变更测试使用注入的假 API，没有创建、修改或发布真实 Release。
真实 Git 图仅在本轮合成临时仓库中构造，没有修改当前分支、标签或远端。

Web 在隔离输出目录完成前后端构建、Electron 隔离守卫、冻结部署、原生/WASM 探针、鉴权冒烟与 tar 打包。
另将压缩包的依赖和锁文件提取到工程外临时目录，再运行探针，确认不依赖开发机父目录解析。
验证前评估本机可用空间，复用现有包缓存；离线部署观测为 18 包复用、0 下载，不进行大规模在线安装。

桌面按项目要求尝试 build:unpack，使用独立 release 输出目录。主/预加载/界面构建完成，
但 electron-builder 原生依赖扫描遇到已有悬空链接 `node_modules/.pnpm/node_modules/@radix-ui/react-compose-refs` 而失败。
链接时间早于本轮，当前锁文件没有该依赖，本轮没有删除链接、重新布局依赖环境或降低检查规则来使其变绿。
因此桌面完整 unpack 仍未通过，也未进行正式签名安装、跨平台产物或真实自动更新验收。

未触发 GitHub Actions、未推送/发布、未向 QQ 或模型服务发测试请求，未修改已安装客户端。
原始审计报告仍保留为历史证据；本轮自建的大型可再生产物验收后清理，原有归档和其他任务现场保留。

## 本地验证回执

2026-10-27（北京时间）验证范围：

- 桌面针对性 Vitest 3 文件、17 项通过；既有授权/发布脚本 Node 测试 5/5 通过，共 22 项。
- 测试包含实际临时 Git 图、注入假 GitHub API、真实 pnpm 离线部署两次及完整锁树/源工作区状态不变反例。
- 当前 Mac arm64 的 Web 完整 build、两项 Electron 隔离守卫、deps、test:dist、pack:release 通过。
- 真实包在工程外解出依赖后，sharp、resvg 和 QuickJS WASM 探针通过；锁文件及摘要存在，本机安装状态未随包发布。
- Web 服务端类型检查、本批 Biome check（零新增警告）及差异空白检查通过。
- 桌面 build:unpack 未通过：现有 Radix 悬空依赖链接导致原生扫描 ENOENT。未将前置编译成功冒称完整打包验收。
- 未跑全仓 CI、未触发真实远端发布或通知、未验证另外四个平台的真实包与安装升级。
