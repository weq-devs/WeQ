# WeQ Remote for iOS

版本：0.1.0，本地开发原型，不是 App Store / TestFlight 发布版。iOS 17 起。

唯一验证功能：扫码或粘贴电脑配对链接，电脑批准后读取 `/v1/status`，显示在线状态、请求耗时和验证时间；可重复验证，电脑撤销后立即拒绝访问。

## 构建

本机只读复用现有 TailscaleKit，不复制整个工程、不改动下一节项目。来源与初始构建指纹在 `Support/tailscale-dependency.json`，BSD 许可证随 App 打包。Framework 必须包含 `TailscaleNode.statusJSON()`，并支持 iOS 真机及模拟器。

```sh
cd /Users/wata4me/Projects/WeQ-upstream
bash apps/ios/scripts/generate-project.sh
xcodebuild -project apps/ios/WeQRemote.xcodeproj -scheme WeQRemote \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath apps/ios/.build/DerivedData CODE_SIGNING_ALLOWED=NO build
```

其他机器通过 `WEQ_TAILSCALE_FRAMEWORK=/absolute/path/TailscaleKit.xcframework` 指定匹配框架再运行生成脚本。XcodeGen 的环境变量路径只写入可再生的 Xcode 工程，不提交本机绝对依赖路径。

真机安装：打开生成的 `apps/ios/WeQRemote.xcodeproj`，选择自己的签名团队与已连接 iPhone 后运行。无签名真机构建不等于可安装 IPA；本轮不自动创建远端 App ID、上传发布或替换其他 App。

## 使用

1. 电脑端开启 WeQ Remote，完成网络登录。
2. 手机点击“连接网络”，通过 App 内网络登录入口加入同一个 tailnet；无需额外安装 Tailscale 或占用系统 VPN。
3. 手机扫描电脑二维码，或在电脑复制配对链接后粘贴；点击“配对电脑”。
4. 两端核对六位校验码，在电脑批准，然后手机显示“电脑在线”。
5. 点击“验证连通”发出新的真实请求。电脑撤销设备后，再验证应提示授权失效。

本版不做免账号扫码入网、后台常连、聊天功能或持久设备授权。设备访问令牌只保留在手机内存；退到后台即取消请求并关闭内嵌节点，返回后需要重新配对。TS 节点身份保留在 App 私有 Application Support，并排除系统备份。

扫码只填入链接，不自动发出配对请求。只接受 v1、无额外字段、`100.64.0.0/10` 数字地址和指定端口；拒绝公网域名、普通 LAN、回环地址、用户信息、路径、查询及重定向。HTTPS 控制面仍按系统与 TS 的证书校验。仅 TS 内的 HTTP 使用网段级 ATS 例外，不允许任意 HTTP。

## 验证

单元测试覆盖邀请解析、目的地址约束、凭据生成、状态协议校验。UI 测试使用原生 App 和电脑端实际的 `RemotePairing` / `createRemoteServer`，不是假 JSON 页面。

普通回环集成测试服务：

```sh
pnpm exec tsx apps/ios/scripts/integration-server.ts
```

仅监听 `127.0.0.1:45198`。它会自动批准测试请求，绝不是产品服务。测试结束关闭进程。
Debug 模拟器测试标志 `--remote-integration-test` 允许通过回环测试真实协议；仅在同时设置合法 `WEQ_REMOTE_TEST_ENDPOINT` 时生效。真机和 Release 编译不含该入口。

隔离 TS 集成网络：构建并运行 `tools/remote-network/ios-test-network`，它启动本地控制面、DERP 与正式电脑端网络辅助程序，不注册公共网络。配置只写入 `apps/ios/.build/network-test.json`；UI 测试检测到该配置后，以 `--remote-ts-integration-test` 和仅回环的 `WEQ_REMOTE_TEST_CONTROL` 启动手机内嵌 TS，实际穿过两端 TS 与 DERP/直连传输，再访问同一配对 API。

```sh
cd tools/remote-network
go build -o weq-remote-network .
go build -o ../../apps/ios/.build/ios-test-network ./ios-test-network
cd ../..
apps/ios/.build/ios-test-network \
  --helper "$PWD/tools/remote-network/weq-remote-network" \
  --config "$PWD/apps/ios/.build/network-test.json"
```

另一个终端运行测试（测试期间保留上述两个进程）：

```sh
xcodebuild -project apps/ios/WeQRemote.xcodeproj -scheme WeQRemote \
  -destination 'platform=iOS Simulator,name=iPhone 18 Pro' \
  -derivedDataPath apps/ios/.build/DerivedData -parallel-testing-enabled NO \
  -collect-test-diagnostics never -test-timeouts-enabled YES \
  CODE_SIGNING_ALLOWED=NO test
```

测试后关闭两个本轮进程及使用的模拟设备，不关闭其他任务设备。隔离 TS 通过不代表真实 iPhone 蜂窝网络、公网控制面登录、相机扫码或 App 分发已验收；实际结果另记。

## 2026-10-22 本机回执

- iOS 27.0 / iPhone 18 Pro 模拟器：6 项单元/连接测试 + 2 项 UI 测试全部通过，无跳过。包含手机内嵌 TS → 本地 DERP/直连 → 正式电脑网络辅助程序 → 真实配对/状态接口，撤销后的 401 拒绝也通过。
- 最后追加网络关闭/重建的安全收尾后，单独重跑真实 TS 连接、撤销、节点重建测试，通过；完整 8 项结果在 `.build/FinalConnectionTests.xcresult`，最新生命周期结果在 `.build/LifecycleTests.xcresult`。
- 真机 arm64 Release 与模拟器 Debug 构建通过；真机 App 未签名，未安装到真实 iPhone，未上传到 TestFlight/App Store。
- 电脑端 16 项针对性测试、Node/Web 类型检查通过；Go 构建、静态检查通过。未跑全仓 CI。
- 真实连通截图导出至仓库 `.codex-local/remote-ios-20261022/screenshots/`，画面中的网络标注为本机 TS 集成测试；不含邀请或凭据，不是手填的假在线状态。
- 测试过程曾因系统合并的无障碍标签导致两项 UI 断言失败，已添加明确的无障碍标识并修复，最终重跑通过；首轮冗长诊断收集被主动中止，不计为通过。
- 测试服务、隔离网络与辅助进程已关闭，使用的模拟设备已停止。

编译产物（可再生、不入 Git）：

- 模拟器：`/Users/wata4me/Projects/WeQ-upstream/apps/ios/.build/DerivedData/Build/Products/Debug-iphonesimulator/WeQRemote.app`
- 真机未签名：`/Users/wata4me/Projects/WeQ-upstream/apps/ios/.build/DeviceBuild/Build/Products/Release-iphoneos/WeQRemote.app`

依赖文档：[TailscaleKit](https://github.com/tailscale/libtailscale/tree/d1dc45d039edb7759ecbee6ba2aea0c4bca884b8/swift)、[Apple ATS 网段例外](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsexceptiondomains)。
