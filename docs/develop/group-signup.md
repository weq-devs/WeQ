# 群报名 / 群收集表（OIDB 0x921b_0）

在群里发一张「群报名」卡片（也叫「群收集表」）：标题 + 详情，可带**报名截止时间**、
**报名方式**、**附带图片**、**报名人数上限**。真机抓包逆向（2026-10-03）。

- 协议实现：`packages/protocol/src/oidb/send-group-signup.ts`（`SendGroupSignup`）
- 服务封装：`InteractionService.sendGroupSignup`（`packages/service/src/account/interaction.ts`）
- MCP 工具：`send_group_signup`（`apps/desktop/src/main/mcp/tools.ts`）

## 信封与请求体

外层是通用 OIDB 信封（native 负责 command/subCommand 包裹），`body` 里再套一层请求：

```
f1  request   （见下表）
f12 fixed=1
```

## request 字段

| 字段 | 编号 | 类型 | 含义 |
| --- | --- | --- | --- |
| empty | 1 | message | 空 message，实测恒出现为 `0A 00`（预留/模板位） |
| groupCode | 2 | uint64 | 群号 |
| title | 3 | string | 标题（如「找搭子」「图片收集」） |
| detail | 4 | string | 详情正文 |
| field5 | 5 | uint32 | 实测恒为 `0`（显式上 wire） |
| deadline | 6 | uint32 | 报名截止时间（**unix 秒，UTC**）。缺席 = 不截止 |
| image | 7 | message | 附带图片（可选），见下 |
| maxCount | 8 | uint32 | 报名人数上限（可调） |
| signupMethod | 9 | uint32 | `1` = 直接报名，`2` = 上传图片 |
| field10 | 10 | uint32 | 实测恒为 `200`（平台默认/上限，与 f8 不是一个字段） |
| field11 | 11 | uint32 | 恒 `0` |
| field12 | 12 | uint32 | 恒 `0` |
| extra | 13 | message | `{ field1: 0, field2: "", field3: "" }`，实测恒出现 |
| field14/15/16 | 14/15/16 | uint32 | 恒 `0` |

`image`（f7）：`{ f1 width, f2 height, f3 url, f4 md5 }` —— url 是图片直链，
md5 是 **32 位小写 hex 字符串**，加上像素宽高。抓包里 url 落在
`vfiles.gtimg.cn/wupload/...`，但服务端按 URL + md5 取图，任意可访问直链都行。

## 抓包样例（群号 673646675）

- 样例1「找搭子」直接报名：`maxCount=14, signupMethod=1`，
  `deadline=1791561600`（2026-10-10 00:00 CST），无图片。
- 样例2「图片收集」上传图片：`maxCount=1, signupMethod=2`，
  `deadline=1791043200`（2026-10-04 00:00 CST），
  `image={ width:1125, height:660, url:vfiles…png, md5:df35… }`。

## 图片怎么来

对外只收 **图片 URL**：服务层（`InteractionService.resolveSignupImage`）会请求一次该 URL，
用 `detectImageFormat`（`@weq/protocol` 的 highway 工具）取宽高、`node:crypto` 算 md5，
再上 wire。**请求不到 / 空响应就直接报错、不发**。

> 仓库现有的图片上传（`0x11c4` → highway）产物是 `multimedia.nt.qq.com.cn` 的富媒体索引，
> 与这张卡片需要的「直链 + md5」对不上，所以这里不做上传，只接受调用方给直链。

## 日期

`deadline` 是 unix 秒（UTC）。MCP 工具 `send_group_signup` 的 `deadline` 入参默认按
**东八区（+08:00）** 理解：接受 `"2026-10-10 00:00"`、带时区的 ISO 串，或 10 位 unix 秒。

## 已知缺口

- **PC/Linux 端发不出去（当前主缺口）**：真机实发被服务端在 OIDB 外层拒绝：

  ```
  Reply status error: 319 ([oidb] rule type not match appid,
    https://iwiki.woa.com/pages/viewpage.action?pageId=4011875093)
  ```

  绕开 native 的 status 检查、直接读 hook 的 control pipe，拿到的**原始 OIDB 返回**
  是一个完整信封（**不是**空 ack）：

  ```
  OidbBase {
    command: 37403 (0x921b), subCommand: 0,
    errorCode: 319,
    errorMsg: "[oidb] rule type not match appid,https://iwiki.woa.com/...",
    body: <trpc-sso 头 + "qq-i18n-tip-msg: 登录态白名单校验失败">
  }
  ```

  与图文 Ark 的 `901501 rule type not match appid` 同源：**平台规则不匹配**
  （服务端只对 Android 端登记的 appId/场景放行），不是字段拼错。`isUid=true/false`、
  `subCommand 0/1/2/3` 都试过，全是同样的拒绝（或 `150 no privilege`）。
  对照验证：同一账号同一条写通道发 `send_poke`（0xED3_1）能成功，排除注入/在线问题。
  要继续推进需要：抓一次 **PC 端自身成功发出的** 群报名（若 PC 端压根不走 0x921b，
  就走它的真实命令），比对 appId/场景字段。
- **native 丢掉了失败详情**：`run_oidb_ex` 在 `reply.status != 0` 时直接返回
  `Reply status error: <status> (<msg>)`，原始 body 被丢弃，所以 TS 侧拿不到结构化
  `errorCode`/body。当前服务层只做错误翻译（把 319 讲成人话），没有原始 body 可附。
- **成功回包结构尚未抓到**：成功时按空 ack 处理（`deserialize` 返回 void）。发出后无法
  从回执确认是否上屏；如需撤回/编辑/查列表，要另抓 0x921b 的响应或相关查询命令。
- **字段布局已校对、发送未通过**：`packages/protocol/test/send-group-signup.test.ts` 用抓包
  request 做了 decode + 逐字节 re-encode 校验；真机发送在 PC/Linux 上被上面那条 319 拦住。

---

[← 返回开发者入口](./index.md)
