# 空友爱看（公共空间）协议接入

日期：2026-10-28（北京时间）。本轮只移植**服务层协议**（`packages/service/src/account/web/qzone_public.ts`），
不动桌面端界面、IPC 路由与导出链。

## 1. 结论先说

- WeQ 之前**没有**空友爱看：仓库里没有任何 `public_qzone` 实现，空间能力全部走
  `ic2.qzone.qq.com` / `taotao.qq.com` 那套旧 CGI（个人空间、好友动态、个人相册）。
- SnowLuma 的实现**不是 OIDB SSO 发包**。它走 h5 的 `http2rpc/gotrpc` JSON 网关，
  只是请求头里塞了 OIDB 命令号让服务端路由到 trpc 后端。
- 空友爱看的动态壳子（`cell_*`）与旧空间完全不是一套：互动必须回传完整 `union_id`
  和 `cell_feed_transfer`，不能拿旧说说的 `tid` 拼。

## 2. 请求形态

```text
POST https://h5.qzone.qq.com/http2rpc/gotrpc/v1/<trpc 服务>/<方法>?g_tk=<bkn>
Cookie: <qzone.qq.com 的完整 jar>
Content-Type: application/json
Referer: https://h5.qzone.qq.com/pc-qzone/index.html
x-web-qua: V1_HT5_QZ_9.9.32_001_IDC_B
x-oidb: {"uint32_command":"0x9741","uint32_service_type":"0"}
```

`g_tk = bkn(p_skey || skey)`，复用 `credential.ts` 的 `computeBkn`；cookie 由
`cookieHeader` 拼（ptlogin2 的完整 jar 优先，四字段兜底）。`x-web-qua` 是 pc-qzone
网页端的 qua，上游按它决定返回哪套 cell 结构，换之前要跟网页版一起验。

响应统一 `{retcode, message, data}`：`retcode !== 0` 或 `data` 不是对象都算失败。
票据类错码（-3000 / -10000）抛 `WebAuthError` 交给 `withRetry` 换票重试一次，其余照常抛错。

## 3. 接口清单

| 能力 | trpc 服务 / 方法 | x-oidb |
| --- | --- | --- |
| 入口能力（有无爱看、能否推） | `trpc.public_qzone.entrance_ctrl.EntranceCtrl/BatchEntranceWhitelist` | `0x9741_0` |
| 推荐流 | `trpc.qzone.feeds_reader.FeedsReader/GetPublicRecomFeeds` | `0x9a38_0` |
| 动态详情 | `FeedsReader/GetFeedDetail` | `0x97b1_1` |
| 评论 / 回复 | `FeedsReader/GetComment`、`GetReplies` | `0x9bfd_1`、`0x9bfe_1` |
| **推 / 取消推** | `trpc.public_qzone.interaction.UFOComment/Upvote` `Downvote` | `0x9d18_1` `0x9d19_1` |
| 赞 / 取消赞 | `trpc.qzone.interaction_writer.InteractionWriter/DoLike` `UnLike` | `0x9699_1` `0x969c_1` |
| 评论/回复点赞（`like_type` 2/3） | 同上 | 同上 |
| 评论 / 回复 | `InteractionWriter/AddComment` `AddReply` | `0x9676_1` `0x9677_1` |
| 删评论 / 删回复 | `InteractionWriter/DeleteComment` `DeleteReply` | `0x9989_0` `0x998a_0` |
| 关注 / 取关作者 | `trpc.public_qzone.relation.RelationService/Follow` `Unfollow` | `0x9d1a_1` `0x9d1b_1` |
| 转发 | `trpc.qzone.feeds_writer.FeedsWriter/ForwardFeed` | `0x969a_1` |

「推」（UFOComment）与「赞」（InteractionWriter）是**两个独立接口**，别合并成一个按钮的
两个字段。

## 4. 三个容易踩的点

### 4.1 目标对象整体透传

详情与所有互动只从 feed 里取：

```json
{ "union_id": { ...cell_common.union_id }, "cell_feed_transfer": { ... } }
```

`cell_feed_transfer` 是上游跨域/跨端识别凭据，必须原样回传；缺失时整个键都不发
（不是发 `{}`）。`union_id` 缺失或为空对象时在发请求前就拒掉 —— 这正是「别用旧说说
tid 拼造目标」那条约束的落点。

### 4.2 推荐流游标

`GetPublicRecomFeeds` 续页要同时带三样：

- `refresh_id`：首次由客户端生成 `uin_时间戳`，整个翻页过程不变；
- `attach_info`：上一页返回的续页标记；
- `last_client_feed_union_id`：上一页**最后一条非广告**动态的 union。

广告项 `cell_common.feed_type === 3` 不能当锚点。一页全是广告时，沿用上一页的锚继续
往下传（不是清空）—— 网页端就是这个行为，实测清空会重复或跳条。

`has_more` 是唯一的结束判据：本页不足 10 条不能停。游标在服务层被封装成 base64url
的不透明串，内部绑定 uin 并做规范编码校验，跨账号或畸形游标在发请求前就被拒。

### 4.3 关注失败在内层

`Follow` / `Unfollow` 的外层 `retcode` 仍是 0，失败信息在 `data.ret_code` /
`data.ret_msg` 里，必须单独判。推荐域（`domain_type === 3`）优先按 `target_uid` 关注，
其余域按 `target_uin`。

### 4.4 真实响应里的字段（2026-10-28 实测）

用真实账号拉过 `GetPublicRecomFeeds`（3 页）、`GetFeedDetail`、`GetComment`、`GetReplies`
后确认的形状，`apps/desktop/src/renderer/src/lib/qzonePublic.ts` 按这套投影：

- 作者在 `cell_user_info.user`，**只有 `uid`**（32 位大写十六进制），`uin` 是空串；
  这个 uid 与本地账号的 `u_xxx` uid 不是一套，不能直接比。
- `cell_common.time` 是**字符串**；正文在 `cell_summary.summary[]`（`type 0` 文本、
  `type 3` 内嵌媒体），表情仍是 `[em]eXXX[/em]`。
- 图片在 `media_items[].image.default_url.url`（`photo_url[]` 是分档），
  视频在 `media_items[].video`：直链 `url`、封面 `cover.default_url.url`、时长 `video_time`（毫秒）。
- 计数分散在 `cell_like.num` / `cell_comment.num` / `cell_foward_info.retweet_count` /
  `cell_visitor.view_num`；`cell_upvote` 常为 null（`can_upvote=false` 的账号）。
- 详情是 `{ feed: { feed: <裸 feed> }, attach_info, has_more }`，首批评论 10 条；
  评论页 `{ cell_comment: { comments }, attach_info, has_more }`，回复页
  `{ replys, reply_attach_info, has_more, total }`。

## 5. 与既有代码的边界

- **复用**：`credential.ts`（`computeBkn` / `cookieHeader` / `WebCredentialProvider` /
  `WebAuthError` / `withRetry`）、`http.ts`（`webRequestJson`，含超时、响应上限、
  空间翻页限流队列、读重试预算）。
- **新增**：`qzone_public.ts` 一个文件；`index.ts` 的 `WebQueryService` 加 14 个方法
  （读走 `withRetry`，写直接取凭据不重放）。
- **未动**：导出链、`packages/protocol`。
- **本轮新增**（2026-10-28 收尾）：`apps/desktop/src/main/ipc/routers/qzone_public.ts`
  （IPC，挂 `account.qzonePublic`）、`views/QzonePublicView.tsx`（空间导航新增一栏）、
  `lib/qzonePublic.ts`（`cell_*` 投影）、`styles/qzone-public.css`；
  空间页里原本私有的媒体网格 / 预览 / 状态件抽到 `views/qzoneShared.tsx` 供两边复用。

评论/回复的身份（`uin` / `uid` / `nick`）由**上层**组装后传入，服务层不读 profile 库 ——
和 `publishQzone` 之类「服务层只做协议」的既有分层一致。

## 6. 验证

`packages/service/test/qzone_public.test.ts`（27 项）覆盖：gotrpc 信封（URL / `g_tk` /
`x-oidb` / qua / Referer）、信封异常不降级、入口只取当前账号、游标跨页锚点与广告页、
畸形/跨账号游标在网络前拒绝、分页异常、详情与评论回复独立分页、推与赞走不同服务、
评论/回复点赞的 `like_type` 与 `like.id`、富文本原样透传、删除与转发、关注 uid/uin
选择与内层 `ret_code`、缺少身份不发请求、写操作不带重试预算。

全部离线、mock 网关，不碰真 QQ 数据库、不联网。**尚未做真实账号验收** —— 需要在线
开发版会话里确认 `BatchEntranceWhitelist` 的 flags、`GetPublicRecomFeeds` 的真实 cell
形状，以及各写操作的回执字段。
