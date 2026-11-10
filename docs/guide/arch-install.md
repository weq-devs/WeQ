# Arch Linux 安装（AUR）

Arch 用户可以直接用 AUR 上的预编译包 `weq-bin`，不需要手动下 Release 压缩包。

## 安装

```bash
paru -S weq-bin
# 或
yay -S weq-bin
```

包会装到：

| 路径 | 内容 |
| --- | --- |
| `/opt/weq/` | 完整的应用目录（`@weqdesktop` + `resources/` + `native/`） |
| `/usr/bin/weq` | 启动入口（导出 `WEQ_PACKAGE_MANAGED=1` 后转调真实二进制） |
| `/usr/share/applications/weq.desktop` | 桌面菜单项 |
| `/usr/share/pixmaps/weq.png` | 图标 |

`weq-bin` 同时提供 `x86_64` 与 `aarch64`，`makepkg` 会按当前机器架构取对应的上游压缩包。

## 更新

```bash
paru -Syu
```

**应用内的「软件更新」不会下载安装包**：包的文件由 pacman 管理，应用自己替换会和
`pacman -Syu` 打架。设置 → 版本 页面仍然可以检查新版本，但按钮会提示改用包管理器；
内置组件过期弹窗里也给出同样的命令。

## 与 AppImage / tar.gz 的关系

三个渠道装出来的是同一份构建产物，目录结构完全一样，只是入口不同：

- **AppImage**：单文件，挂载在临时目录运行；更新走应用内自动下载新 AppImage。
- **tar.gz**：解压即用；同样支持应用内更新。
- **AUR (`weq-bin`)**：由 pacman 安装到 `/opt/weq`；**更新只能走包管理器**。

三者用同一份用户数据目录（`~/.config/WeQ/`），换渠道不用迁移配置。

## 卸载

```bash
paru -R weq-bin
```

用户数据（`~/.config/WeQ/`、账号配置、导出结果）不会随包删除；需要一并清掉时手动删除该目录。
