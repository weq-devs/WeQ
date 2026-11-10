# 签名器定位缓存与 QQ 版本看门（2026-11-08）

完整模式发包要借 QQ `wrapper.node` 里的两位「签名入口」：

- **sign core** —— 完整签名函数 `sign(cmd, src, len, seq, out)`，输出 token / extra / sign；
- **VM 入口** —— 自建状态机用的解释器，我们自己算 `md5(token ‖ extra ‖ payload)` 再调它。

两者的位置**随 QQ 版本变化**（RVA 不同），而定位要遍历 140–200 MB 的模块：
实测冷启动 `checkSigner` 约 2.5–3 秒（`sign core` 定位 ~400 ms，真正的大头是
容器解析 + RTTI 链 + 反汇编）。

这篇记录做了什么、为什么这么切，以及后续怎么维护。

## 一、为什么要缓存

旧行为是「第一次需要签名时现场扫」。代价很直观：

1. 用户点进完整模式后，第一个需要签名的请求要等 3 秒；
2. QQ 每次自动更新都会换 `wrapper.node`，这个代价每次更新后都要付一遍；
3. 扫的过程中如果文件被替换（QQ 在更新），还可能拿到错位的 RVA。

现在改成**按目标模块预热 + 按文件指纹缓存 RVA**：Windows / Linux 仍在启动期预热；
macOS 自 2026-11-09 起等完整模式确认运行中 QQ 后，才预热该进程实际加载的模块。

| 场景 | 耗时 |
| --- | --- |
| 首次（无缓存） | ~3.0 s，写回缓存 |
| 命中缓存 | ~0.55 s（只 dlopen + 加载器初始化） |
| 文件变了 | 回到首次，写回新缓存 |

命中缓存时 native 侧跳过的正是最贵的「静态扫描」，dlopen 本身省不掉（函数指针
必须来自真实加载的模块）。

## 二、缓存放哪、怎么失效

`<appData>/signer-cache.json`，按 `wrapper.node` 绝对路径索引：

```json
{
  "entries": {
    "/opt/QQ/resources/app/wrapper.node": {
      "version": "3.2.35-54395",
      "wrapperPath": "/opt/QQ/resources/app/wrapper.node",
      "sha256": "DC5209E2...",
      "stamp": { "size": 152017008, "mtimeNs": "1793..." },
      "signCoreRva": 109404804,
      "vmRva": 115675340,
      "vmKind": "linux-vm-entry",
      "verifiedAt": 1794133000000,
      "pathUsed": "vm"
    }
  }
}
```

两把钥匙：

1. **路径** —— QQ 换版本会换路径（win32 是 `versions/<ver>/…`、linux 是
   `versions/<ver>-<build>/…`），所以新版本天然 miss；
2. **`size + mtimeNs`** —— 同路径原地替换时靠它发现；真正重算 SHA-256 只在需要
   留档（首次扫描 / 诊断页）时做，140 MB 约 0.2 秒，不放进热路径。

`sha256` 本身**不参与判定**，只用来在 `versions/supported.json` 里留一份
「这个版本的 wrapper 长什么样」的锚点。

## 三、RVA 也是「提示」，不是事实

`setSsoSession` 现在可以带 `signCoreRva` / `vmRva`。native 侧的处理：

```
有 hint → Image::open + 可执行段校验
          ├─ 通过  → 直接绑定函数指针（~0.5 s）
          └─ 不通过 → 记 warning，退回完整扫描
```

**校验必须做**：hint 来自上一次运行，可能是另一个架构的切片、也可能文件已经被
QQ 换掉。直接 `transmute` 一个越界的 RVA 就是进程崩溃。

实际生效的 RVA 通过 `signerRvas(wrapperPath)` 读回，`signer_cache` 在校验后发现
和缓存不一致时**立刻回写**，所以「native 重扫过一次」这件事会自动收敛。

## 四、预热放在哪

Windows / Linux 在 `initAppContext` 中预热安装模块。macOS 启动期没有账号目标时跳过；
账号监视器确认完整模式凭据就绪后，按账号的 QQ PID 解析实载 wrapper，再预热同一份模块。
诊断页状态与手动重新扫描也使用相同目标，不回退加载另一个安装版本。
macOS 启动时仍会从磁盘恢复文件指纹匹配的 RVA 提示（最多 64 个条目），只读缓存与
文件元数据、不加载模块；第一次登记会话仍可使用这些提示，由 native 校验后绑定。

```ts
const wrapperPath = await resolveSignerWrapper(platform, uin);
if (isCurrent()) {
  return warmupSigner(
    platform.native.ntHelper,
    platform.appDataRoot(),
    wrapperPath,
    readQqVersion(wrapperPath),
  );
}
```

macOS 热更新可能让应用安装目录中的 wrapper 落后于运行版本。先预载安装旧版、
再在完整模式加载热更新版，会重复注册 Objective-C 类，并产生大量 `objc` 警告。
这里消除多余加载，不全局关闭原生诊断；已加载两份模块的进程需完整重启。

- **不挂首屏查询**：预热独立启动，发包路径不等待它；
- **优先缓存**：命中时使用 native 异步 `warmupSigner` 校验；未命中仍走现有 `checkSigner` 扫描与缓存回写；
- **失败不致命**：预热只返回 `bool`，真正的签名错误在 `send_packet` 处带上下文报。

发包路径不等预热完成 —— 没预热完就退回 native 自己的扫描（慢一点，但正确）。
预热成功的结果写进 `signer_cache` 的进程内 `memoryHints`，`registerSsoSession`
登记会话时从这里取。

## 五、降级要「说出来」

VM 定位失败时签名会退回完整签名函数：功能还能用，但慢，且只发 `SecSign`
（没有自建的 token/extra 一致性）。这种「能用但退化了」的状态**必须有明确提示**：

- 完整模式确认成功的那一刻，如果签名器处于降级状态，弹一条 warning toast，
  并给出指向「设置 → 诊断工具 → 签名器」的入口；
- 诊断页的状态卡常驻展示：缓存版本、文件 SHA-256、两条 RVA、上次确认时间、
  当前走哪条路径，以及手动「重新扫描」。

`RestrictedMode.tsx` 里那段 effect 只在 `fullModeConfirmed` 为真时触发一次
（`signerWarned` ref 去重），不打扰受限模式的其它提示。

## 六、版本清单与每晚看门

### 文件

| 文件 | 内容 | 谁写 |
| --- | --- | --- |
| `versions/latest.json` | 官网当前五平台最新版本 + 下载地址 | `pnpm versions:refresh --write` |
| `versions/supported.json` | 已验证过的版本（带 sign 结果 / RVA / sha256）与待验证队列 | 同脚本写 `pending`；CI 验证通过后写 `platforms` |

五个键是 `windows-x64` / `linux-x64` / `linux-arm64` / `macos-x64` / `macos-arm64`。
macOS 官方只发一个 universal dmg，但「能不能在某个架构上签名」必须在对应架构的
runner 上分别验，所以拆成两条、共用同一个下载地址。

### 数据源

官网下载页本身用的接口，不是 HTML 解析：

```
https://qq-web.cdn-go.cn/im.qq.com_new/latest/rainbow/pcConfig.json
https://im.qq.com/proxy/domain/qq-web.cdn-go.cn/im.qq.com_new/latest/rainbow/pcConfig.json
```

<<<<<<< HEAD
**CDN 有灰度期，别指望发布当天就能下**（2026-11-08 实测）：

- `pcConfig.json` 里给的是 `QQNTV2/<ver>/release/<hash>/…`，**直接 `curl` 一律
  403**（防盗链，浏览器里也拿不到，官网页面同样是靠 JS 拼参数）；
- 同一批产物在 `QQNT/<ver>/beta/<hash>/` 下、用旧式命名
  （`linuxqq_3.2.35-54395_amd64.deb`）能下 —— **但只对已经放开的版本有效**：
  9.9.36 及以前都能下，9.9.37 发布当天 beta 路径也还是 404/403；
- 更麻烦的是 **`pcConfig.json` 本身在边缘节点间不同步**：同一天我本地拿到
  `9.9.37`，GitHub runner 拿到 `9.9.36`。

所以：

1. `versions/latest.json` 原样记录官网给的地址（作为「官方声明」留档），
   **不猜 URL** —— 猜出来的 build 号拼错只会更糟；
2. **版本只允许前进**（`mergeLatest`）：某次抓到旧版本时不覆盖已有记录，
   否则清单会每晚抖动；
3. 下载 403/404 记 warning + 跳过本轮，**不判红**；其它失败（网络错误、
   返回 HTML、文件过小）判红；
4. 每天按「该平台最新版**是否已验证**」重新决定跑不跑 compat（不是只在清单
   变化那晚跑），所以灰度放开后自动补上一轮。
=======
**注意 CDN 的防盗链**：`pcConfig.json` 里给的是 `QQNTV2/<ver>/release/<hash>/…`
路径，直接 `curl` 会 403（参考站也复现）。真正可下的是同一批版本的
`QQNT/<ver>/beta/<hash>/linuxqq_<ver>-<build>_<arch>.deb` 形态 —— 现有
`versions/latest.json` 记录的是**官网给的地址**（作为「官方声明」留档），
`.github/workflows/qq-version-watch.yml` 的下载步骤对 403 记 warning 而不是判红：
腾讯对新版本有一段灰度期，隔天通常会放开。
>>>>>>> origin/main

### 流程

```
schedule(UTC 16:00 / 北京 00:00)
<<<<<<< HEAD
  └─ refresh: 抓 pcConfig → 合并（只前进）→ 写 latest.json + pending
                → 清单有变化就 commit 到 main
                → plan: 算出「最新版还没验证」的平台列表 unverified
       └─ unverified != []
            └─ compat (matrix，只跑 unverified 里的平台)
                 ├─ 从 weq-devs/nt_helper_release 拉 pinned 的预编译 .node（不编译）
                 ├─ 校验产物带 checkSigner（缺就明确报错停止）
                 ├─ 下载安装包 → scripts/extract-qq-wrapper.mjs 取整个 app 目录
                 ├─ checkSigner(wrapper, 3) —— 三次签名必须全部成功
                 └─ 签名失败 → job 红（不自动修）
=======
  └─ refresh: 抓 pcConfig → 写 latest.json + pending → 有变化就 commit 到 main
       └─ changed == true
            └─ compat (matrix 五平台)
                 ├─ 从 weq-devs/nt_helper_release 拉 pinned 的预编译 .node（不编译）
                 ├─ 下载安装包 → scripts/extract-qq-wrapper.mjs 取整个 app 目录
                 ├─ checkSigner(wrapper, 3) —— 三次签名必须全部成功
                 └─ 任何失败 → job 红（不自动修）
>>>>>>> origin/main
            └─ record: 只把 ok 的组合并进 supported.json，再 commit 到 main
```

「只红不修」是刻意的：RVA 定位失败意味着 QQ 改了签名器结构，VM 入口可能要重新逆，
自动改代码只会把问题藏起来。workflow 的职责是**把问题按时暴露给维护者**。

### QQ 通知

每晚只要探测到**新版本**（`kind === "upgrade"`），无论兼容性验证是通过、失败，
还是 CDN 暂未放开，都会用和 Release 相同的 `qq-notify-action` 发一条简短
Markdown 报告；没有新版本不发，避免每晚刷屏。报告由
`scripts/qq-version-report.mjs` 汇总，正文只列本轮变化的平台和 compat 验证结论
（包含旧 pending 的重试），按钮直达本轮 Actions 与 `versions/latest.json`。

### 本地跑

```bash
pnpm versions:refresh          # 只打印
pnpm versions:refresh --write  # 落盘
pnpm versions:refresh --check  # 落后官网则退出码 1

node scripts/extract-qq-wrapper.mjs ./QQ_3.2.35_amd64.deb /tmp/unpack
node -e 'const nt=require("./native/linux/x64/nt_helper.node");
         console.log(nt.checkSigner("/tmp/unpack/app/wrapper.node", 3))'
```

## 七、已知边界

- **AppImage / rpm 没接**：解包脚本只处理 deb / dmg / exe；官网主要发 deb。
- **compat 依赖带 `checkSigner` 的 native 产物**：`native/pinned.json` 指向的
  构建如果太老，两个 workflow 都会在「产物能力检查」这一步明确失败 —— 这是
  有意的（比跑到一半报「不是函数」清楚）。升级路径见 `native/pinned.json` 的 note。
- **macOS dmg 挂不上时的降级**：拿到的单文件缺 `ScreenCaptureAgent.framework`，
  动态签名会失败但静态定位可用 —— 脚本会如实报告失败，不假装通过。
- **Windows 安装包必须在 Windows 上解**（NSIS `/S /D=`），本地 Linux 只能做静态分析。
- **缓存不随 WeQ 升级迁移**：文件路径不变就继续用，这是有意的（换 WeQ 不影响 QQ）。
