# 好友添加时间、方向与来源协议研究（2026-11-06）

## 结论与证据等级

已找到官方「他的线索」的完整页面请求链，能够一次请求读取好友添加时间、添加方向、
来源文案、来源群标识和验证消息；不需要用首条聊天记录或空间互动时间反推。

本轮结论来自 **Android QQ 9.3.75 静态调用链 + 当前腾讯官方 H5/SDK 源码**，
尚未发送真实账号查询，因此不是当前 Mac 登录态已验证可用的结论。
本日后续已接入产品，实施与验证状态见文末。

- 页面：[https://ti.qq.com/friends/recall](https://ti.qq.com/friends/recall)。
- 页面当前引用的固定构建：
  [66f10f75/index.bundle.js](https://qq-web-legacy.cdn-go.cn/ti.qq.com_friends/66f10f75/app/recall/dist/cdn/index.bundle.js)。
- 桥接 SDK：[qqapi.wk.js](https://qq-web.cdn-go.cn/library/latest/qqapi/qqapi.wk.js)。
- 页面无登录时输出的 `verifyTime=0`、`addFrdType=1` 等是初始状态，不是任何好友的真实数据。

## 官方调用链

```text
Android relationx.friendclue.c（FriendClueConfigHelper）
  -> https://ti.qq.com/friends/recall?uin=<目标好友 UIN>
  -> fetchFriendInfo
  -> mqq.data.ssoRequest
  -> mqq.invokeClient("sso", "sendRequest", ...)
  -> SSOWebviewPlugin.handleJsRequest 的 sendRequest 分支
  -> SSOWebviewPlugin$RequestTask
  -> WebSsoBody.WebSsoRequestBody + TrpcProtoServlet
```

`FriendClueManager` 主要承接备注编辑和共同群跳转，不是这几个关系字段的直接解析器。
配置项 `friend_clue_config.friendClueSwitch` 控制入口展示；不能据此推断服务器接口可用性。

页面实际调用为：

```js
mqq.data.ssoRequest({
  cmd: 'OidbSvc.0xeb1_1',
  data: { uint64_friend_uin: Number(targetUin) },
}, callback);
```

目标为数字 **UIN**，不是 `u_` 开头的 UID。示例体现页面行为；宿主实现仍应校验
整数及范围，不接受 `parseInt` 的部分解析或静默精度丢失。

## 实际 SSO 命令与包体

**不能把页面中的命令名直接交给普通 `sendOidbPacket(0xeb1, 1, ...)`。** SDK 将 `data`
对象转成 JSON 字符串。Android 桥接从当前页面主机名倒序拼接命令前缀：

```text
ti.qq.com -> com_qq_ti
MQUpdateSvc_com_qq_ti.web.OidbSvc.0xeb1_1
```

这条是由已核对的安卓桥接规则确定的传输配方，尚未通过真实回包确认。

`WebSsoRequestBody` 的 protobuf FieldMap：

| tag | 类型 | 字段 | 本页面分支 |
| --- | --- | --- | --- |
| 1 | uint32 | version | 没有显式 set |
| 2 | uint32 | type | 显式 set(0)，JSON 模式 |
| 3 | string | data | `{"uint64_friend_uin":<目标 UIN>}` |
| 5 | message | login_sig | 本页面未传 domainId，默认 0，不走设置分支 |
| 6 | bytes | bytes_openid | 未设置 |

`login_sig` 并非所有 WebSSO 请求都不需要：RequestTask 对 `domainId>0` 会另取
票据并设置。这里只说明当前线索页面的实际参数，不推广到其他页面。

回包为 `WebSsoResponseBody`，**不是 OIDBSSOPkg**：

| tag | 类型 | 字段 |
| --- | --- | --- |
| 1 | uint32 | version |
| 2 | uint32 | type |
| 3 | uint32 | ret |
| 4 | string | data，业务 JSON |
| 5 | message | controlData，含 frequency/packageSize 等客户端控制信息 |

Android observer `ax` 将 data 作为 JS 回调的 `data`、ret 作为 `retcode`，另有传输失败的
`cret` / `cret_msg`。页面再 `JSON.parse(data)`，仅在 JSON 的 `ErrorCode===0` 时赋值。
宿主读取应分别判断传输、WebSSO ret 与业务 ErrorCode，不能只看到 JSON 就当成功。

WeQ 已有 `@weq/protocol` 的 `sendPacket`、protobuf 编解码及 native 通用发送能力，
后续验证可以复用，不需要新增 native 接口。Mac 当前会话是否接受这条命令、签名要求
及适配层长度头处理尚未实测，不以安卓 `Packet` 的封装方式直接类推。

## 返回字段

下表字段名直接来自官方页面的响应消费代码；它们是 **JSON key，不是 protobuf tag**。

| 字段 | 官方页面用途 | 已确认语义 |
| --- | --- | --- |
| `uint64_add_frd_time` | 加好友时间 | 页面乘 1000 后传给 Date，原值为 Unix 秒 |
| `uint32_add_frd_type` | 验证信息标题 | 2 显示「我添加他时的信息」；页面其他值显示「他添加我时的信息」 |
| `str_add_frd_source_wording` | 来源 | 直接显示服务端给出的文案，不是本地枚举推导 |
| `str_add_frd_message` | 附加信息 | 添加验证文字；页面还处理「问题／回答」格式 |
| `uint64_group_id` | 来源群跳转目标 | 页面与 `bool_group_jump` 一起决定能否打开群资料 |
| `bool_group_jump` | 来源点击行为 | 服务端给出的群资料可跳转标志，不由当前是否在群推测 |
| `uint32_comm_group_num` | 共同群聊数量 | 只给数量；点击后通过客户端另开共同群列表 |
| `str_nickname` | 昵称 | 好友昵称 |
| `str_remark` | 备注名 | 当前账号的好友备注 |
| `str_mobile_name` | 通讯录名 | 页面非空时展示 |
| `str_group_name` | 分组 | 好友所在分组名称，不是来源群名称 |
| `ErrorCode` / `ErrorInfo` | 业务状态 | 页面要求 ErrorCode 严格等于数字 0 |

### 添加方向

可以确定 **2=我添加对方**，因为官方组件的 getter 直接以这个值选择中文标题。
默认状态为 1，响应赋值使用 `uint32_add_frd_type || 1`；因此 **1 对应页面的「他添加我」
分支**。但这不足以证明协议只有 1/2 两种合法值，也不能把缺失、0 或未知值都归为对方主动。
产品模型应保留原始值，只有明确的 1/2 生成方向，其他为未知。

### 时间及来源的精度

- 原始时间为秒，官方页面仅展示年月日；WeQ 可以保留原值和带明确时区的展示值。
- 用户于 2026-11-06 明确补充：时间为最近一次添加时间，WeQ 中统一标为「添加时间」。
  这是用户提供的时间语义，不是本轮静态源码或真实回包实验得出的结论。
- 该结果是单条信息，不是完整加删好友历史。互相请求、免验证添加、旧关系缺失等分支未验证。
- 已找到来源文案和群标识；**未找到独立来源数字枚举、邀请人或原搜索词字段**，不编造映射。
- `str_add_frd_message` 是原始验证内容，不能把它的出现时间另说成同意请求的精确时间。
- 页面有省略值填默认值的逻辑；宿主不能照搬成真实数据。空来源不等于「通过 QQ 号搜索」。

## 建议的最小验证

1. 复用当前在线会话，对一个已知好友发送上述 WebSSO 请求，不改 AppID、QUA 或登录设备。
2. 检查 WebSSO 外层、业务 ErrorCode、字段存在性与原始类型，并保留 uint64 的精度。
3. 选已知主动、被动和群来源的现有关系分别与官方线索页核对；未知值不填默认结果。
4. 对已有删后重加记录的好友交叉核对用户提供的「最近一次添加」语义，不为实验制造加删好友操作。
5. 确认后再接到现有资料查询：时间、方向、来源文案、来源群、验证消息分开返回；
   原始值与解析结果同时保留，失败与空字段分开。

本轮没有真实账号请求、添加／删除好友、改动资料、启用模拟器或变更 WeQ 产品代码。
也没有用腾讯云 IM SDK 的好友字段代替个人 QQ 协议。

## 本地复核证据

既有研究目录：`/Users/wata4me/Agents/2026-10-19-WeQ会话交互/work/protocol-parts-2-4-20261022/`。
本轮 `friend-clue-evidence-20261106.mjs` 下载并保存三份公开页面／脚本原文，核对调用及
字段片段、记录 SHA-256，并校验七份核心安卓 smali 窗口。回执为同名 JSON。
这些检查只证明静态证据一致，不是线上查询回归测试。

关键安卓类均复用已校验 DEX，由现有 `android-inspect.mjs` 经 `android-sdk-run` 读取：

- `classes6.dex`：`relationx.friendclue.c`，确认官方页面 URL。
- `classes7.dex`：`SSOWebviewPlugin`，确认 sendRequest 与主机名反向拼接规则。
- `classes32.dex`：`SSOWebviewPlugin$RequestTask`，确认 type=0、JSON data、domainId 分支。
- `classes7.dex`：`WebSsoBody$WebSsoRequestBody` / `$WebSsoResponseBody`，确认 FieldMap。
- `classes32.dex`：`webviewplugin.ax`，确认回调中的 data / retcode 与控制字段。
- `classes14.dex`：`TrpcProtoServlet`，确认继承及响应传输处理。

本轮另查了配置类 b/d、FriendClueConfigParser 与 WebSSOAgentServlet。
后者服务于另一条 uniAgent 分支，不与本页的 sendRequest 混用。

## 同日产品接入

- 协议：`packages/protocol/src/oidb/profile/friend-clue.ts`，复用通用 SSO 发送及 wire 遍历；
  校验传输外层、业务错误、字段类型、时间范围与整数精度，缺失和未知方向不默认成被动添加。
- 服务：`AccountWriteService.friendClue(uid)` 从当前好友目录解析 UIN，发包前后复核运行时。
- API：`account.qqWrite.friendClue`，绑定账号及 configId，并在异步返回后复核账号与目标。
- UI：好友资料和群成员名片的关系信息区显示添加时间、方向、来源及原始验证消息；群来源直接展示群头像和群名，不再单列来源群号，点击打开群名片。
  群名优先使用现有 `groupJoinSettings`（`0x88d_110`）接口返回的名称，不使用好友分组名或群备注；已有群资料保留成员与公告，未收录群不虚构本地资料。
  日期按北京时间展示，不再提供手动重读按钮；好友线索及来源群资料读取失败后间隔 1 秒自动重试，最多额外重试两次，不持续轮询。查询失败不展示旧结果，字段沿用现有隐私模式标记。
- 不使用旧 `Contact.createdAt` 作为添加时间，不改 QQ 数据库；Web/Remote 复用相同资料界面和路由。
- 本次验证为合成数据离线测试和界面排版核验，真实 QQ 回包仍未验收；没有发版或安装。

### 接入验证回执

- 定向测试通过：protocol 35 项（好友线索及既有共同关系）、service 9 项（线索与账号编排）、
  desktop 92 项（线索展示、IPC、好友资料和成员名片等），共 136 项。
- protocol/service 类型检查、desktop node/web 类型检查及 14 个改动代码文件 Biome 通过。
- Headless Edge 对真实资料行 DOM 与既有样式核验：4 种状态 × 3 种宽度 × 深浅色 ×
  2 种主题色，共 48 组；减少动态效果与网格背景下无横向溢出、文字溢出或标签／值重叠。
  查看了深色正常状态、浅色超长验证消息的 320px 截图。
- 排版原文、截图与回执在既有研究目录的 `friend-clue-qa-20261106/`，脚本为
  `friend-clue-browser-20261106.mjs`；本次浏览器已关闭。
- 首轮 pnpm 参数分隔意外扩大测试范围：protocol 包整轮 803 项通过、1 项 todo；
  service/desktop 扩大范围的运行已中止，未将中止当作通过。后续均用 `exec vitest run <文件>`
  重新执行上述定向范围，未运行 `ci:local`。
