# 数据目录与设备 guid

## QQ 数据目录速查

三端的数据根和账号目录命名规则都不一样。这里把常用路径一次算清。

<QqDataPathExplorer />

数据根默认值：

| 平台 | 数据根 |
| --- | --- |
| Windows | `<Tencent Files>`（QQ 自己记在 `UserDataInfo.ini` 里，常见是 `文档\Tencent Files`） |
| Linux | `~/.config/QQ` |
| macOS | `~/Library/Containers/com.tencent.qq/Data/Library/Application Support/QQ` |

::: tip

Windows 的账号目录是 `<数据根>/<QQ号>/nt_qq`；Linux / macOS 是
`<数据根>/nt_qq_<md5(md5(uid) + "nt_kernel")>` —— 文件名里**没有 QQ 号**，所以少了 uid
就算不出来。uid 可以从 `login.db`、`profile_info.db` 或 `gpro_v1-6_<uid>.db` 的文件名里找到。

:::

## 设备 guid 预测

`guid` 是 QQ 认设备的依据，和登录凭据无关。它由本机已有的几个固定值算出来，
**改掉来源值就等于换了一台设备**。

<GuidCalculator />

### 三端的来源

| 平台 | guid 公式 | 来源文件 |
| --- | --- | --- |
| Linux | `md5(machine-id ‖ MAC)` | `/etc/machine-id` + `global/nt_data/msf/machine-info` |
| macOS | `md5(machine_id[8] ‖ sn)` | `global/nt_data/msf/machineid-info`（TEA 容器）+ 磁盘序列号 |
| Windows | 由注册表里的机器标识派生 | `<msf>\Registry20` 或 `Registry2.0.db` |

Linux 的 `machine-info` 是 `be32(len) + ROT13(MAC)`，**不是加密**：把文件里的字符做一次
ROT13 就能读出 MAC。`/etc/machine-id` 结尾的换行也参与 MD5，去掉就对不上。

::: warning

换 guid 之前必须先退出所有 QQ 实例。`machine-info` / `machineid-info` / `Registry20`
都是 QQ 常驻读写并缓存到内存的，在线时改完会被它覆盖回去。

:::

## 在 WeQ 里做同样的事

| 想做的事 | 入口 |
| --- | --- |
| 看本机 guid、一键复制 | 设置 → 凭据与账号 → QQ 登录记录管理 |
| 随机换 guid（写回来源文件） | 同上，「随机更换」 |
| 看账号目录里到底有什么 | [本地资源页](/guide/database-view) |

对应原生接口：`readDeviceGuid(dataRoot)` / `writeDeviceGuid(dataRoot)`，见
[nt_helper.node 接口文档](/develop/nt-helper-interface)。
