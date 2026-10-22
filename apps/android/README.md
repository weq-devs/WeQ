# WeQ Remote for Android

版本 0.1.0，开发测试原型，Android 8.0 / API 26 起，当前仅构建 arm64-v8a。

功能与最小 iOS 原型一致：App 内登录 TS 网络，扫码或粘贴电脑配对链接，电脑核对校验码并批准，然后读取在线状态、请求耗时和验证时间。电脑撤销后拒绝旧凭据。不开系统 VPN，不开放聊天数据或 QQ 写操作。

## APK 与使用

交付 APK：`/Users/wata4me/Projects/WeQ-upstream/apps/android/.build/weq-remote-0.1.0-arm64.apk`。
这是本机测试签名，不是商店正式发布。`-test.apk` 是独立包名的自动化测试版本，不作为普通客户端交付。

1. 安装普通 APK，点击“连接网络”，登录与电脑相同的 tailnet。
2. 扫描电脑配对码，或复制电脑端的配对链接后粘贴。
3. 点击“配对电脑”，两端核对六位码，在电脑批准。
4. 点击“验证连通”，发出新的实际请求。

当前不支持免账号扫码入网、后台常连、聊天功能或持久设备授权；退后台、重建界面会取消当前电脑连接，返回后需重新配对。TS 身份保存在 App 私有 no-backup 目录，设备访问令牌只保留内存。未启用网络时不主动注册节点。

## 构建

使用 Java 原生控件、标准 Android SDK 构建工具与固定版本 gomobile，不需要新下载 Android Studio 或 Gradle。网络模块独立维护 `network/go.mod` / `go.sum`，不升级电脑端依赖。

本机工具：Go 1.27.2、JDK 17、SDK/API 36、Build Tools 36.0.0、NDK 28.2.13676358。
`ANDROID_HOME` / `ANDROID_NDK_HOME` 可覆盖默认 SDK/NDK 路径。

```sh
cd /Users/wata4me/Projects/WeQ-upstream
python3 apps/android/scripts/build.py
python3 apps/android/scripts/build.py --test --skip-network
bash apps/android/scripts/check-protocol.sh
cd apps/android/network
go test -p 2 ./...
```

首次构建下载小型 Go 工具和固定的 ZXing 3.5.3 JAR，复用本机 SDK 与系统镜像；不下载整套 IDE。APK 包含 Go/TS 依赖的许可证文本。测试签名密钥按 Android 惯例保存在 `~/.android/debug.keystore`，不进仓库。

## f 盘模拟器

本轮独立 AVD：`WeQRemote_API36`，端口 5580。
用户数据：`/Volumes/f = \mu N/Runtime/WeQRemote/android/avd/WeQRemote_API36.avd`。
只读系统镜像复用本机现有 `system-images;android-36;google_apis;arm64-v8a`；没有再复制一份 SDK 镜像。已有的其他 AVD 不动。

启动脚本先实时检查 Volume UUID 与真实挂载点，再核对 AVD 注册入口，最后接统一 `external_disk_guard.py`。缺盘、UUID 不匹配不创建 SSD 替代目录；hold 由统一 guard 停止外盘 I/O。cwd 始终留在本机项目。

```sh
diskutil info -plist '/Volumes/f = \mu N'
# 使用实时核实的 VolumeUUID；本轮 AVD 已创建，不必再次 --create。
python3 apps/android/scripts/emulator.py \
  --volume '/Volumes/f = \mu N' --uuid '<实时核实的VolumeUUID>'
```

配置为无窗口、无音频、禁快照、2 核。SDK 会将 Android 36 的 RAM 最小值提升为约 2.5 GB。首次启动需要完成系统初始化；测试后正常关闭本轮设备：

```sh
~/Library/Android/sdk/platform-tools/adb -s emulator-5580 emu avd name
~/Library/Android/sdk/platform-tools/adb -s emulator-5580 emu kill
```

## 真实 TS 集成验证

```sh
python3 apps/android/scripts/integration.py --serial emulator-5580
```

脚本仅接受 `WeQRemote_API36`；复用现有本机测试控制面、DERP、正式电脑端网络辅助程序和真实 `RemotePairing` / `createRemoteServer`，不登录公共 tailnet。ADB reverse 只用于让模拟器访问本机测试控制面与中继；App 的 `/v1/pair`、`/v1/status` 实际经过内嵌 TS，不改走系统 HTTP 冒充加密通道。

自动检查默认不启动网络、配对、实际状态读取、重复请求、撤销后的 401，并检查浅/深色。专用 `cn.wata4me.weq.remote.test` APK 才启用回环测试控制面与测试 instrumentation；普通 APK 不接收这些测试 Intent 参数，也不允许系统明文 HTTP。

截图前必须确认活动窗口属于测试 App，防止被系统对话框遮挡时仍把功能断言冒称完整界面验收。

测试截图与日志保存在 `.build/connected-light.png`、`.build/connected-dark.png`、`.build/integration.log`。脚本结束清理本轮测试服务和反向端口；模拟设备由操作者按上节正常关闭。日志不记录邀请、访问令牌或节点身份密钥。

真实手机的相机、公共控制面登录、跨公网/蜂窝切网及长期耗电需另外验收，不能用本机模拟器结果代替。

## 2026-10-22 验证回执

- 普通版与专用测试版均构建成功，APK v2 / v3 签名校验通过，普通版约 8.4 MiB；版本为 0.1.0，本机测试签名，未上架。
- 普通交付 APK 已实际安装、冷启动检查通过；默认网络未启动，无测试标记、无系统遮挡，清单无测试 instrumentation 且不允许系统明文 HTTP。
- Go 桥接的 4 项离线单元测试通过；Java 邀请、目的地址、重复字段、随机凭据、哈希兼容性及真实二维码编码/解码检查通过。
- Android 16 / API 36 arm64 专用模拟器：浅色、深色两轮原生 instrumentation 通过。实际经过手机内嵌 TS → 本地直连/DERP → 正式电脑网络辅助程序 → 真实配对及状态 API，重复请求和撤销后的 401 均通过。活动窗口检查通过，截图无系统遮挡，不是手填假在线状态。
- 首轮发现 JNI 进程缺少安全日志状态目录导致 SDK panic，已固定到 App 私有 no-backup 目录，并补充离线回归。日志上传仍关闭。
- 虚拟机冷启动曾出现系统/系统 UI 未响应对话框；已正常清除、改用宿主 GPU、关闭本测试设备的蓝牙和动画，并在加入可见窗口检查后重跑通过。被遮挡的早期截图不作为交付。
- 初次冷编译已完成，后续复用 SDK、系统镜像和 Go 缓存；未升级电脑端 Go 依赖，未改动其他 AVD、LidAwake 或现用服务。
- 本轮测试进程、反向端口及专用测试包已清理，普通版保留在本项目 AVD 便于后续复测；模拟设备已正常关闭。未跑全仓 CI。

本轮交付 APK 的 SHA-256：`68b6668617ce6c2be3348c50f1222b1b8059000f7004ae70b5060a5bc4c311fe`。

构建输出和测试图为可再生产物，不进 Git。真实手机、相机和公网链路尚未验收。

依赖：[Go Mobile](https://go.dev/wiki/Mobile)、[Tailscale tsnet](https://pkg.go.dev/tailscale.com/tsnet)、[ZXing](https://github.com/zxing/zxing/tree/zxing-3.5.3)。
