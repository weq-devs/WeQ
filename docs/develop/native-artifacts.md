# 原生二进制与装扮资源的分发

`nt_helper.node`（5 个平台）和装扮离线索引分别分发，二进制与大索引不进入 WeQ 的 Git 历史。
native 从 [`weq-devs/nt_helper_release`](https://github.com/weq-devs/nt_helper_release) 获取；
装扮索引从 [`weq-devs/dress-resources`](https://github.com/weq-devs/dress-resources) 的明确版本 Release 获取。
桌面与 Web 安装包只保留索引清单、排名及界面素材，不携带三份 `.dat`。

## 为什么要拆出去

这两类文件每次 native 构建都会变：`.node` 是 5 个平台各十几 MB 的 Rust cdylib，
`*.dat` 是重新 AES 加密过的几十 MB 的包。历史上每次构建都往主仓 PR 一次，
把 `.git` 顶到 538 MB —— 其中 1204 MB（未压缩内容）是 `native/**`、222 MB 是 `dress/*.dat`。
清洗后仓库降到 **61 MB**（见文末清洗记录）。

## 目录与来源

| 路径 | 是否入库 | 来源 | 更新方式 |
| --- | --- | --- | --- |
| `native/<platform>/<arch>/nt_helper.node` | 否 | `weq-devs/nt_helper` 的 Rust 构建 | `pnpm native:fetch` |
| `native/<platform>/<arch>/weq-authorization-helper[.exe]` | 否 | 同一私有仓的独立 Rust target | 清单包含助手时由 `pnpm native:fetch` 获取 |
| `resources/dress/index-manifest.json` | 是 | 已验证的独立资源 Release | 同步更新资源版本、native commit、体积及哈希 |
| `cache/dress_shared/index/<资源 tag>/{bubble,widget,font}.dat` | 否 | `weq-devs/dress-resources` Release | 首次需要时按类别自动获取 |
| `resources/dress/screen/**`、`ranking-*.json` | 是 | 手工整理的静态素材 | 正常提交 |
| `resources/dress/*_resources` | 否 | `scripts/fetch_dress_resources.ts` 抓取 | 本地生成，喂给 native 构建 |

NineBird 注入链、`packages/ninebird` 与旧 `native/**/ninebird` 已移除，不再手工同步或执行
`build:ninebird`。文末的 2026-09-16 清洗记录描述当时的保留范围，不是当前目录清单。

## 两条硬约束

1. **`.node` 与 `.dat` 必须同源。** `.dat` 的 AES key 由 nt_helper 的构建 commit 派生
   （`DRESS_KEY_SEED`，见 nt_helper 的 `build.rs`）并烘焙进 `.node`。跨版本混用会让
   `queryDressResourceUrl()` 永远返回 `null` —— 装扮离线查询静默退化成联网协议。
   当前保留现有加密格式，因此资源清单的 `nativeCommit` 必须与 native 锚点一致。
   独立分发不等于任意版本可混用；打包前会校验两份锚点。
2. **`.node` 有有效期。** CI 构建带 `BUILD_TIMESTAMP`，`getInitStatus()` 在过期后返回
   `-1`；本地 `cargo` / `napi` 自编的不带时间戳，不受此限。有效期长度**只由 nt_helper
   的 Rust 定义一处**（`common::BUILD_VALIDITY_SECS`），二进制通过 `getBuildInfo()`
   自报 `buildTime` / `expireTime`；WeQ 侧（脚本、CI、UI）一律按这个时间戳判断，不抄天数。
   所以发布时间到了就得换一份新的，而 `--require-fresh`（剩余不足 1/5 有效期）会把过期
   构建挡在打包之前。

## 版本锚：`native/pinned.json`

长期授权的公开/私有边界、可选产物清单及兼容规则见[长期授权集成](long-term-authorization.md)。旧 tag 没有助手时仍能正常取回 `.node`，不据此声称长期授权可用。

桌面 release 额外使用 `--require-authorization` 强制检查助手；Web 使用 `--no-authorization` 避免携带仅供本机桌面管理的可执行文件。升级锚点时应对同一明确 tag 使用 `--require-fresh --require-authorization --verify --write-pin`，校验失败不会写锚点。

`pnpm native:fetch` **默认取的是 `native/pinned.json` 里锚定的那个 tag**，不是 latest。

为什么：WeQ 的代码是照着某一份 native 构建写的（类型、能力、甚至装扮资源的 AES 密钥都由
它决定）。一直跟着 latest 漂，会在"WeQ 已经用到新字段、而本地那份还是旧的"这类情况下
静默降级 —— 比如 native 新增了分块扫描的键探针，旧构建不认识它，只会退化成慢路径。
锚文件是这个仓库里**唯一**一处"我们认哪一份 native"的记录，改动它是一次显式提交。

```json
{ "tag": "nt-helper-20260918-5c4d8b2", "commit": "5c4d8b2…", "pinnedAt": "2026-09-19", "note": "…" }
```

native 内容校验靠该 tag 的 `manifest.json`；`commit` 还用于检查装扮索引的密钥来源，
`note` 是人工说明。升级 native 时应同步确认 `resources/dress/index-manifest.json`。
升级锚点的完整流程：

```bash
# 先从发布清单确定要验证的明确 tag，以下两步始终使用同一个 tag。
pnpm native:fetch --version <tag> --require-fresh --require-authorization --verify
# 跑与 native 升级直接相关的回归；确认后写锚点。
pnpm native:fetch --version <tag> --require-fresh --require-authorization --verify --write-pin
# 同步验证并更新 resources/dress/index-manifest.json，再提交两份版本锚与必要源码变更。
# 不提交下载的二进制或装扮包。
```

`--latest` 可用于发现或试用新构建，不应在验证和写锚点两步间重新解析不同的 latest。
默认 fetch 始终取锚定 tag，重复下载不会延长其有效期。

`pnpm native:check` 发现本地与锚点不一致（缺失 / 落后 / 内容被换过 / 已过期）就退出码 1，
并会提醒上游有没有更新的构建。手动丢一份自编 `.node` 进去也躲不过：sha256 对不上。

## dev 用法

普通开发直接运行 `pnpm dev`：发布版模式准备并验证 native，不预下载大索引；应用实际需要装扮时按类别获取。已完整安装的 native 可离线复用。本地源码模式仍编译并验证配套三类资源，不尝试用发布版密钥索引补齐本地构建。切换来源、源码指纹和失败恢复见[一行命令开发启动](dev-startup.md)。

```bash
pnpm native:fetch                 # 本机平台 native（锚定的 tag）
pnpm native:fetch --with-dress    # 显式取旧版配套索引，非普通启动必需
pnpm native:check                 # 只比对：缺失 / 落后 / 被改 / 已过期 → 退出码 1
pnpm native:preflight             # 桌面发布预检：只读检查新鲜度、完整性与权限助手
pnpm native:fetch --all           # 五个平台全量（全平台测试、做镜像时用）
pnpm native:fetch --platform linux-arm64
pnpm native:fetch --latest        # 忽略锚点，取上游最新（试用新构建用）
pnpm native:fetch --dress-only    # 只补装扮资源
pnpm native:fetch --verify        # 装完 require 一次并跑 getInitStatus()
pnpm native:fetch --no-authorization # 独立 Web 不下载权限助手
pnpm native:fetch --version nt-helper-20260916-86cb5a4
pnpm native:fetch --from-dir ./dist   # 从本地目录装（离线 / 镜像；目录里要有 manifest.json）
```

| 环境变量 | 作用 |
| --- | --- |
| `NT_HELPER_RELEASE_REPO` | 覆盖发布仓，默认 `weq-devs/nt_helper_release` |
| `NT_HELPER_RELEASE_BASE_URL` | 覆盖下载前缀（镜像 / 代理），默认 GitHub Releases |
| `NT_HELPER_VERSION` | 钉死 tag，等价于 `--version`（CI 里临时试构建用） |
| `NT_HELPER_RETRIES` | 单次请求最多尝试几次，默认 8（含第一次） |
| `NT_HELPER_HTTP_TIMEOUT_MS` | 单次请求无响应多久算超时，默认 60000 |
| `HTTPS_PROXY` / `HTTP_PROXY` | 出网代理（另支持 `NO_PROXY`）。脚本自己读这几个变量走 CONNECT 隧道 —— Node 内置 `fetch` 不认它们，Clash 之类只开 HTTP 代理又没开 TUN 时直连 GitHub 会超时 |

GitHub Releases 的 `github.com/.../releases/download/...` 会 302 到 CDN，这条链路会间歇性
返回 504（2026-11-09 发布 v2.5.2 时连续挂了三次，本地也能复现单轮 10/10 失败）。脚本因此把
manifest 与每个资产都按「整次尝试」重试：5xx / 429 / 408 / 网络超时按指数退避（2s 起、30s
封顶、带抖动），404 / 401 这类不重试。重试日志会打在 stderr，不影响 `--quiet` 之外的输出。

拉完之后 `native/.installed.json` 记着当前装的是哪个 tag、哪些文件、各自 sha256；
它是机器相关状态，已被 gitignore（**入库的那个是 `native/pinned.json`**，见上一节）。

## 装扮索引按需获取

宿主读取随应用发布的固定清单，首次需要未缓存的气泡、字体或挂件时获取对应类别。
同宿主各账号、桌面、Web 和 Remote 共用一份文件与下载任务，不跟随远端 latest。
下载先验证体积和 SHA-256，再原子安装；进度和失败显示在任务列表，失败可重试。

已缓存素材直接使用，不等待索引下载；旧索引仍存在且摘要匹配时后台复制迁入全局缓存，保留原件。
旧安装目录已被更新器替换时，无法事后找回已删除的 bundled 索引，但现有素材缓存不会重下。
QQ 在线协议与后台索引下载互不阻塞；QQ 不在线时，可通过索引获取素材地址。
索引只记录地址，不包含全部素材，完全断网且从未缓存的字体或图片仍无法下载。

原生文件及安装记录在暂存区验证后成套替换；中途写入失败恢复旧内容，验证失败不改版本锚。
发布工作流清理前实际核查 Release 的 draft 状态，不因后续索引推送失败删除正式版本。

## 当前发布链路

```
weq-devs/nt_helper (私有源码)
  Release：将指定 ref 转发到公开构建仓
    -> weq-devs/nt_helper_release / Release
       固定源码 commit，单次加工加密索引，五平台构建和配套读取验证
       -> nt_helper-<日期>-<短 SHA> Release
          .node × 5、权限助手 × 5、装扮 .dat × 3、manifest.json、SHA256SUMS

weq-devs/dress-resources / Release dress indexes
  读取明确 native tag 的公开清单和三份 .dat，验证后原样分发
    -> dress-<短 SHA> Release
       .dat × 3、index-manifest.json、SHA256SUMS

WeQ 构建
  native/pinned.json -> 下载本平台 native 及所需助手
  resources/dress/index-manifest.json -> 随包保留，不预下载索引
  两份清单的 native commit 必须匹配；运行时按类别获取 .dat
```

当前阶段独立的是分发，资源生成仍沿用 native 构建与原加密格式；不表示资源已能脱离 native commit 任意更新。
资源仓仅保存发布工具、格式契约和测试，大索引只放 Release，不进入 Git 历史。

native 发布工作流先由独立任务加工一套三类索引，保持 NTDR v1、Brotli q9、AES-256-CBC 和 commit 派生密钥不变。五平台编译通过 `NT_HELPER_PACK_DRESS=0` 只嵌入同源密钥，不再各自重复压缩、加密；每个平台实际验证 addon 能读取本轮共享索引，发布前再比对草稿资产与共享文件。中转仅含加密索引与来源／哈希清单，按 artifact ID 下载，收尾清理，最长保留一天。发布入口及最终资产契约不变；这不是解除资源与 native commit 的绑定。新工作流要求私有源码版本已包含内部加工工具，旧 ref 不自动改用其他来源。

明确版本的下载入口（不需要 API 或 token）：

```
https://github.com/weq-devs/nt_helper_release/releases/download/<tag>/<asset>
https://github.com/weq-devs/dress-resources/releases/download/<资源 tag>/index-manifest.json
https://github.com/weq-devs/dress-resources/releases/download/<资源 tag>/dress-<类别>.dat
```

native 仓的 `latest/download/manifest.json` 可用于发现新构建，不是 WeQ 默认获取来源。
native `manifest.json` 结构：

```json
{
  "tag": "nt-helper-20260916-86cb5a4",
  "commit": "<nt_helper commit sha>",
  "builtAt": "2026-09-16T05:12:33Z",
  "runId": "1234567890",
  "source": "weq-devs/nt_helper@<sha>",
  "dressKeySeed": "<sha>",
  "platforms": {
    "linux-x64": { "asset": "nt_helper-linux-x64.node", "sha256": "…", "size": 13924216 }
  },
  "dress": { "bubble": { "asset": "dress-bubble.dat", "sha256": "…", "size": 24530053 } }
}
```

native 发布仓使用 `GITHUB_TOKEN` 发布资产及提交 `latest.json`，工作流需要 `contents: write`；
`latest.json` 提交使用 `github-actions[bot]` 身份。私有源码的 ref 解析和拉取使用 `NT_HELPER_TOKEN`，
私仓分发入口使用 `RELEASE_DISPATCH_TOKEN` 触发公开构建仓。
独立资源仓只读取已发布的公开资产，使用自己的 `GITHUB_TOKEN` 发布，不需要拉取私有源码。

### 升级独立索引

1. 选择已验证的明确 native tag，在资源仓运行 `Release dress indexes`，填写 `native_tag`。
2. 资源工作流默认 `preflight_only=true`，仅获取和校验；关闭该选项才发布。两种模式都不会重爬或重新加密索引。
3. 资源发布后，使用同一 Release 的 `index-manifest.json` 更新 WeQ 固定清单，核对 `nativeCommit` 与 native 锚点一致。
4. 运行本地清单检查，再使用对应正式 addon 做真实下载和离线复用验收；后一个命令会联网，不接入普通离线单测。

```bash
node --input-type=module -e 'import { checkDressManifest } from "./scripts/dress-artifacts.mjs"; checkDressManifest(process.cwd());'
pnpm exec tsx scripts/check-dress-index.ts --addon /absolute/path/to/nt_helper.node
```

## WeQ 的 release 流水线

`.github/workflows/release.yml` 的五个平台桌面 job 在安装依赖后执行：

```yaml
- name: Fetch nt_helper native artifacts
  run: node scripts/fetch-native.mjs --require-fresh --require-authorization --verify
```

Web 发布矩阵改用 `--require-fresh --no-authorization --verify`，压缩包显式排除权限助手。
CI 的 Web 构建冒烟仍执行 `--require-fresh --verify`，不等同于桌面 release 的助手门禁。
桌面打包另在 `afterPack` / `afterSign` 校验实际包内双产物，详见[长期授权集成](long-term-authorization.md)。

每个 runner 只取自己平台那一份 native 与所需助手，不下载三份 `.dat`（**按 `native/pinned.json` 锚定的 tag**，
不是 latest）。`--require-fresh` 在剩余有效期不足 1/5 时失败 —— 也就是说锚点太旧时，发布会在
打包之前就失败，而不是发出一个起不来的安装包；`--verify` 在 runner 上真的 `require()` 一次
并跑 `getInitStatus()`，二进制有问题当场失败，而不是等用户装上才发现。

`pnpm native:fetch --write-pin` 会把二进制自报的 `builtAt` / `expiresAt` 一起写进
`native/pinned.json`；WeQ 的 Release 说明就取这两个值（不再单独跑构建去问）。

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
git clone --mirror https://github.com/weq-devs/WeQ /tmp/weq-remote-backup.git

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
git clone https://github.com/weq-devs/WeQ /tmp/weq-fresh && cd /tmp/weq-fresh
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
