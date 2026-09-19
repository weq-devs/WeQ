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
   本地 `cargo` / `napi` 自编的不带时间戳，不受此限。所以发布时间到了就得换一份新的，
   而 `--require-fresh`（默认 25 天）会把过期构建挡在打包之前。

## 版本锚：`native/pinned.json`

`pnpm native:fetch` **默认取的是 `native/pinned.json` 里锚定的那个 tag**，不是 latest。

为什么：WeQ 的代码是照着某一份 native 构建写的（类型、能力、甚至装扮资源的 AES 密钥都由
它决定）。一直跟着 latest 漂，会在"WeQ 已经用到新字段、而本地那份还是旧的"这类情况下
静默降级 —— 比如 native 新增了分块扫描的键探针，旧构建不认识它，只会退化成慢路径。
锚文件是这个仓库里**唯一**一处"我们认哪一份 native"的记录，改动它是一次显式提交。

```json
{ "tag": "nt-helper-20260918-5c4d8b2", "commit": "5c4d8b2…", "pinnedAt": "2026-09-19", "note": "…" }
```

只有 `tag` 有校验意义（校验靠那个 tag 的 `manifest.json` 里的 sha256）；`commit` / `note`
是给人看的。升级锚点的完整流程：

```bash
node scripts/fetch-native.mjs --latest --verify    # 1. 试用新构建：装完当场 require + getInitStatus()
#   （跑测试确认没问题）
node scripts/fetch-native.mjs --latest --write-pin # 2. 把这次取到的 tag 写回 pinned.json
#   3. 提交 pinned.json（外加 dist 里需要跟着走的 native/** 产物）
```

`pnpm native:check` 发现本地与锚点不一致（缺失 / 落后 / 内容被换过 / 已过期）就退出码 1，
并会提醒上游有没有更新的构建。手动丢一份自编 `.node` 进去也躲不过：sha256 对不上。

## dev 用法

```bash
pnpm native:fetch                 # 本机平台 + 装扮资源（锚定的 tag）
pnpm native:check                 # 只比对：缺失 / 落后 / 被改 / 已过期 → 退出码 1
pnpm native:fetch --all           # 五个平台全量（全平台测试、做镜像时用）
pnpm native:fetch --platform linux-arm64
pnpm native:fetch --latest        # 忽略锚点，取上游最新（试用新构建用）
pnpm native:fetch --dress-only    # 只补装扮资源
pnpm native:fetch --verify        # 装完 require 一次并跑 getInitStatus()
pnpm native:fetch --version nt-helper-20260916-86cb5a4
pnpm native:fetch --from-dir ./dist   # 从本地目录装（离线 / 镜像；目录里要有 manifest.json）
```

| 环境变量 | 作用 |
| --- | --- |
| `NT_HELPER_RELEASE_REPO` | 覆盖发布仓，默认 `H3CoF6/nt_helper_release` |
| `NT_HELPER_RELEASE_BASE_URL` | 覆盖下载前缀（镜像 / 代理），默认 GitHub Releases |
| `NT_HELPER_VERSION` | 钉死 tag，等价于 `--version`（CI 里临时试构建用） |

拉完之后 `native/.installed.json` 记着当前装的是哪个 tag、哪些文件、各自 sha256；
它是机器相关状态，已被 gitignore（**入库的那个是 `native/pinned.json`**，见上一节）。

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

每个 runner 只取自己平台那一份 `.node` + 三个 `.dat`（**按 `native/pinned.json` 锚定的 tag**，
不是 latest）。`--require-fresh` 挡住超过 25 天的构建 —— 也就是说锚点太旧时，发布会在打包
之前就失败，而不是发出一个起不来的安装包；`--verify` 在 runner 上真的 `require()` 一次
并跑 `getInitStatus()`，二进制有问题当场失败，而不是等用户装上才发现。

需要跑最新的 native 构建前，先把锚点升级（见上一节），否则 CI 打出来的仍是旧的那份。

## 历史清洗记录（2026-09-16，一次性，已完成）

| 指标 | 清洗前 | 清洗后 |
| --- | --- | --- |
| 本地 `.git` | 538 MB（pack 534.49 MiB） | **63 MB**（pack 62.20 MiB） |
| 从 GitHub 全新 clone | — | **65 MB / 6 秒** |
| commit 数 | 777 | 777（除下述 8 个文件外逐字节不变） |
| 全历史 `nt_helper.node` / `dress/*.dat` | 108 / 24 个 blob | 0 / 0 |

> GitHub 页面上的 "Repository size" 是异步重算的，强推之后一段时间里仍会显示旧值
> （当时看到的就是 539 MB 没变）—— 以 `git clone` 的实际体积为准。

清洗范围（**代码与素材的当前版本全部保留**）：

- `native/**/nt_helper.node`，含历史里两种旧命名 `native/darwin/arm|intel/`；
- `resources/dress/{bubble,widget,font}.dat`；
- `resources/emoji/<数字>/**` 与 `resources/emoji.zip`（早已不在追踪的历史垃圾；
  `market.csv` / `emoji_config.json` 保留）；
- `native/**/ninebird/*` **不动** —— 当前版本继续入库，历史也一并保留。

最终 HEAD 树相对清洗前只少 8 个文件（5 个 `nt_helper.node` + 3 个 `.dat`），其余提交
逐字节不变；47 个 tag（含只在远端存在的 `v1.0.0`）全部重指到重写后的等价提交。

### 实际执行的命令

```bash
# 0) 留档：重写会把二进制从工作区一起删掉；另外先在别处镜像一份远端作为回退点
mkdir -p /tmp/weq-native-keep
cp -a native /tmp/weq-native-keep/native
cp -a resources/dress/bubble.dat resources/dress/widget.dat resources/dress/font.dat /tmp/weq-native-keep/
git clone --mirror https://github.com/H3CoF6/WeQ /tmp/weq-remote-backup.git

# 1) 重写（filter-branch，777 commits 实测 34 秒；没装 filter-repo 也够用）
FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch --force \
  --index-filter "git rm -r --cached --ignore-unmatch -q ':(glob)native/**/nt_helper.node' \
    resources/dress/bubble.dat resources/dress/widget.dat resources/dress/font.dat \
    resources/emoji.zip 'resources/emoji/[0-9]*'" \
  --tag-name-filter cat -- --all
rm -rf .git/refs/original && git reflog expire --expire=now --all

# 2) 放回留档的二进制（此时它们已是 ignored 的本地文件），然后重打包
cp -a /tmp/weq-native-keep/native/. native/
cp -a /tmp/weq-native-keep/bubble.dat /tmp/weq-native-keep/widget.dat \
      /tmp/weq-native-keep/font.dat resources/dress/
rm -f .git/ORIG_HEAD .git/FETCH_HEAD
git repack -adf --window=250 --depth=50 && git gc --prune=now
git count-objects -vH          # 期望 62 MB 上下

# 3) 强推（分支 + tag）
git push --force origin main dev
git push --force origin --tags
```

注意 pathspec 用的是 `:(glob)native/**/nt_helper.node`：默认 pathspec 的 `*` 会跨 `/`，
不用 glob magic 容易误伤同名前缀的其它文件。

验证（在**全新 clone** 里做，才是别人实际拿到的结果）：

```bash
git clone https://github.com/H3CoF6/WeQ /tmp/weq-fresh && cd /tmp/weq-fresh
du -sh .git                                               # 65 MB
git rev-list --count --all                                # 768（本地另有 9 个私有分支的提交）
git tag | wc -l                                           # 47
git rev-list --objects --all | grep -c nt_helper.node     # 0
git rev-list --objects --all | grep -c 'resources/dress/.*\.dat'   # 0
git fsck
node scripts/fetch-native.mjs --verify                    # 取最新产物并当场跑 getInitStatus()
```

### 这次踩到的坑

1. **对象被"看不见的地方"吊住**，`gc` 之后 `.git` 只瘦了一半：
   - `.git/ORIG_HEAD` / `.git/FETCH_HEAD` 里还记着重写前的 tip；
   - **其它 worktree 的 index**（`.git/worktrees/<name>/index`）里缓存着旧 tree ——
     本仓库有个挂在 `dev2` 上的 `WeQ2` worktree，它的 index 里那 8 个文件还是 staged 状态。
   这些都会让 git 认为旧的大 blob 仍然可达（`repack -a` 会原样带上）。清掉这两个文件、
   并把对应 worktree 的 index 刷新（`git -C <worktree> reset`）之后，再
   `repack -adf` 才能回到 62 MB。
2. **远端独有的 tag**：`v1.0.0` 只存在于 GitHub（本地没有），强推 tag 不会动它，它会
   继续指向旧提交、把整条旧历史留在服务端。要按「author/committer 时间戳 + 提交信息」
   找到等价提交再 `git tag -f` 重指。
3. **PR refs**：GitHub 的 `refs/pull/*` 不受强推影响（当时 71 个），旧对象还会被它们
   引用着。想让 GitHub 侧的体积真正降下来，得等它自己 GC，必要时找 Support 清 dangling。
4. 老 clone 只 `git fetch` 不会回收本地 pack，要么**重新 clone**，要么
   `git fetch --prune --tags --force && git reflog expire --expire=now --all && git gc --prune=now`。

### 其它提醒

- 重写改掉了所有 commit sha，47 个 tag 全部强推。GitHub Release 的 tag 名不变、
  资产与下载链接照旧，但 Release 指向的 commit 变了。
- fork 与已关闭 PR 里的副本清不掉；已开的 PR 会失效（动手前确认 `gh pr list` 为空）。
- 本地 `dev2` / `docs/history` / `feat/qzone` / `tmp` 等私有分支和 stash 会被一起重写：
  废弃的先删，要留的（stash）先导成 patch。
- `LICENSE` 一个字节都别改：它的 sha256 烘在 `.node` 里，改了所有构建都会报
  「组件已损坏或被篡改」。
