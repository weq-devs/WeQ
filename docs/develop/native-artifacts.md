# 原生二进制与装扮资源的分发

`nt_helper.node`（5 个平台）和加密后的装扮资源 `resources/dress/*.dat` **不再入库**。
它们由私有 native 仓 `H3CoF6/nt_helper` 构建后发布到公开仓
[`H3CoF6/nt_helper_release`](https://github.com/H3CoF6/nt_helper_release)，WeQ 这边按需取回。

## 为什么要拆出去

这两类文件每次 native 构建都会变：`.node` 是 5 个平台各十几 MB 的 Rust cdylib，
`*.dat` 是重新 AES 加密过的几十 MB 的包。历史上每次构建都往主仓 PR 一次，
把 `.git` 顶到 538 MB —— 其中 1204 MB（未压缩内容）是 `native/**`、222 MB 是 `dress/*.dat`。
清洗后仓库降到 **61 MB**（见文末清洗记录）。

## 目录与来源

| 路径 | 是否入库 | 来源 | 更新方式 |
| --- | --- | --- | --- |
| `native/<platform>/<arch>/nt_helper.node` | 否 | `H3CoF6/nt_helper` 的 Rust 构建 | `pnpm native:fetch` |
| `resources/dress/{bubble,widget,font}.dat` | 否 | 同上（`build.rs` 打包 + AES 加密） | `pnpm native:fetch` |
| `native/<platform>/<arch>/ninebird/*` | **是** | `H3CoF6/nt_helper` 的 NineBird 构建 | 手工同步（另一条链，未自动化） |
| `resources/dress/screen/**`、`ranking-*.json` | 是 | 手工整理的静态素材 | 正常提交 |
| `resources/dress/*_resources` | 否 | `scripts/fetch_dress_resources.ts` 抓取 | 本地生成，喂给 native 构建 |

## 两条硬约束

1. **`.node` 与 `.dat` 必须同源。** `.dat` 的 AES key 由 nt_helper 的构建 commit 派生
   （`DRESS_KEY_SEED`，见 nt_helper 的 `build.rs`）并烘焙进 `.node`。跨版本混用会让
   `queryDressResourceUrl()` 永远返回 `null` —— 装扮离线查询静默退化成联网协议。
   所以 `pnpm native:fetch` 永远从**同一个 release tag** 成对取。
2. **`.node` 满 30 天失效。** CI 构建带 `BUILD_TIMESTAMP`，`getInitStatus()` 返回 `-1`；
   本地 `cargo` / `napi` 自编的不带时间戳，不受此限。因此 release 流水线每次都取最新那份，
   并用 `--require-fresh`（默认 25 天）把过期构建挡在打包之前。

## dev 用法

```bash
pnpm native:fetch                 # 本机平台 + 装扮资源（latest）
pnpm native:check                 # 只比对：缺失 / 落后 / 被改 / 已过期 → 退出码 1
pnpm native:fetch --all           # 五个平台全量（全平台测试、做镜像时用）
pnpm native:fetch --platform linux-arm64
pnpm native:fetch --dress-only    # 只补装扮资源
pnpm native:fetch --verify        # 装完 require 一次并跑 getInitStatus()
pnpm native:fetch --version nt-helper-20260916-86cb5a4
pnpm native:fetch --from-dir ./dist   # 从本地目录装（离线 / 镜像；目录里要有 manifest.json）
```

| 环境变量 | 作用 |
| --- | --- |
| `NT_HELPER_RELEASE_REPO` | 覆盖发布仓，默认 `H3CoF6/nt_helper_release` |
| `NT_HELPER_RELEASE_BASE_URL` | 覆盖下载前缀（镜像 / 代理），默认 GitHub Releases |

拉完之后 `native/.installed.json` 记着当前装的是哪个 tag、哪些文件、各自 sha256；
它是机器相关状态，已被 gitignore。

装扮资源缺失不会让程序崩：`queryDressResourceUrl()` 返回 `null`，调用方退化成在线协议。
纯前端 / 服务端开发不跑 `native:fetch` 也能干活，只是拿不到装扮离线数据。

## 发布链路

```
H3CoF6/nt_helper (私有)                     H3CoF6/nt_helper_release (公开)
  Rust-Release-Build (workflow_dispatch)
    build × 5 平台  ─────────────────────►  GitHub Release: nt-helper-<yyyymmdd>-<sha7>
      nt_helper.node × 5                       ├ nt_helper-win32-x64.node
      resources/dress/*.dat                    ├ nt_helper-linux-x64.node
    publish-release job                        ├ nt_helper-linux-arm64.node
      （stage → manifest → Release）            ├ nt_helper-darwin-x64.node
                                               ├ nt_helper-darwin-arm64.node
                                               ├ dress-{bubble,widget,font}.dat
                                               ├ manifest.json
                                               └ SHA256SUMS
                                             main 分支: README.md + latest.json
                                               ↑ 与 Release 里的 manifest 同源
```

稳定入口（不需要 API、不需要 token）：

```
https://github.com/H3CoF6/nt_helper_release/releases/latest/download/manifest.json
https://github.com/H3CoF6/nt_helper_release/releases/download/<tag>/<asset>
```

`manifest.json` 结构：

```json
{
  "tag": "nt-helper-20260916-86cb5a4",
  "commit": "<nt_helper commit sha>",
  "builtAt": "2026-09-16T05:12:33Z",
  "runId": "1234567890",
  "source": "H3CoF6/nt_helper@<sha>",
  "dressKeySeed": "<sha>",
  "platforms": {
    "linux-x64": { "asset": "nt_helper-linux-x64.node", "sha256": "…", "size": 13924216 }
  },
  "dress": { "bubble": { "asset": "dress-bubble.dat", "sha256": "…", "size": 24530053 } }
}
```

发布需要 GitHub App 在 `nt_helper_release` 上有 `contents: write`（安装时把这个仓库勾上）。
发布仓里的提交由 App 自己的 bot 身份署名（`ninebird-bot[bot]`，workflow 里用安装令牌调
`/user` 动态取，不要写死用户名 —— 否则会撞上同名的真实 GitHub 账号）。

## WeQ 的 release 流水线

`.github/workflows/release.yml` 的 6 个打包 job（windows / linux-x64 / linux-arm64 /
macos-x64 / macos-arm64 / web）在 `pnpm install` 之后各插了一步：

```yaml
- name: Fetch nt_helper native artifacts
  run: node scripts/fetch-native.mjs --require-fresh --verify
```

每个 runner 只取自己平台那一份 `.node` + 三个 `.dat`。`--require-fresh` 挡住超过 25 天的
构建；`--verify` 在 runner 上真的 `require()` 一次并跑 `getInitStatus()`，
二进制有问题当场失败，而不是等用户装上才发现。

## 历史清洗记录（2026-09，一次性的）

本地实测数字：

| 步骤 | `.git` |
| --- | --- |
| 清洗前 | 537 MB |
| 去掉 `native/**` + `resources/dress/*.dat` | 146 MB |
| 再去掉已废弃的 `resources/emoji/<id>/**` + `emoji.zip` 历史 | **61 MB** |

清洗范围（**代码与素材的当前版本全部保留**）：

- `native/**` 整个目录从历史里移除；`native/**/ninebird/*` 当前版本仍继续入库，
  只是历史里的旧副本清掉；
- `resources/dress/{bubble,widget,font}.dat`；
- `resources/emoji/<数字>/**` 与 `resources/emoji.zip`（早已不在追踪的历史垃圾；
  `market.csv` / `emoji_config.json` 保留）。

试跑校验：775 个 commit、46 个 tag 一个不少；HEAD 树相对清洗前只少 24 个文件
（21 个 native + 3 个 dat）；全历史里 `nt_helper.node` 与 `resources/dress/*.dat` 命中数为 0。

### runbook

```bash
# 0) 前提：nt_helper_release 已经有第一份 release；fetch-native 的改动已经合进
#    dev/main 并验证过（那时 native/*.node 还在追踪，CI 依旧能跑）
git clone --mirror git@github.com:H3CoF6/WeQ.git /tmp/weq-backup.git      # 备份

# 1) 把当前工作区里的二进制留档（重写会把它们从工作区一起删掉）
mkdir -p /tmp/weq-native-backup
cp -a native /tmp/weq-native-backup/native
cp -a resources/dress/bubble.dat resources/dress/widget.dat resources/dress/font.dat /tmp/weq-native-backup/

# 2) 重写（推荐 git-filter-repo；没装就 pip install git-filter-repo）
git filter-repo --force --invert-paths \
  --path native \
  --path resources/dress/bubble.dat \
  --path resources/dress/widget.dat \
  --path resources/dress/font.dat \
  --path-glob 'resources/emoji/[0-9]*' \
  --path resources/emoji.zip
# filter-repo 会顺手删掉 origin，记得加回来：
#   git remote add origin git@github.com:H3CoF6/WeQ.git
#
# 没有 filter-repo 时可用 filter-branch（本机实测 34 秒）：
#   FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch --force \
#     --index-filter "git rm -r --cached --ignore-unmatch -q native \
#       resources/dress/bubble.dat resources/dress/widget.dat resources/dress/font.dat \
#       resources/emoji.zip 'resources/emoji/[0-9]*'" \
#     --tag-name-filter cat -- --all
#   rm -rf .git/refs/original && git reflog expire --expire=now --all

# 3) 放回留档的二进制（此刻它们是 ignored 的本地文件）
cp -a /tmp/weq-native-backup/native/. native/
cp -a /tmp/weq-native-backup/bubble.dat /tmp/weq-native-backup/widget.dat \
      /tmp/weq-native-backup/font.dat resources/dress/
git gc --prune=now
git count-objects -vH          # 期望 60 MB 上下

# 4) 强推（tag 也得推）
git push --force origin --all
git push --force origin --tags
```

验证清单：

```bash
git rev-list --count --all                                        # 775
git tag | wc -l                                                   # 46
git rev-list --objects --all | grep -c nt_helper.node             # 0
git rev-list --objects --all | grep -c 'resources/dress/.*\.dat'  # 0
git fsck
pnpm install && pnpm native:fetch && pnpm dev                     # 冒烟
```

### 风险与提醒

- 重写会改掉所有 commit sha，46 个 tag 全部要强推。GitHub Release 的 tag 名不变、
  资产与下载链接照旧，但 Release 指向的 commit 变了。
- 已开的 PR / fork 会失效：动手前确认 `gh pr list -R H3CoF6/WeQ` 为空。
- 通知协作者**重新 clone**。老 clone 只 `git fetch` 的话本地 pack 还是 538 MB；
  也可以 `git fetch --prune --tags --force && git reflog expire --expire=now --all && git gc --prune=now` 试着回收。
- 服务端旧对象要等 GitHub 侧 GC，必要时找 Support 清理；fork 里的副本清不掉。
- 本地 `dev2` / `docs/history` / `feat/qzone` / `tmp` 等分支和 stash 会被一起重写：
  废弃的先删，要留的（stash）先导成 patch。
- `LICENSE` 一个字节都别改：它的 sha256 烘在 `.node` 里，改了所有构建都会报
  「组件已损坏或被篡改」。
