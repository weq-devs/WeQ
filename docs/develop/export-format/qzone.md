# 空间

状态：待实现设计。入口：`qzone.basic.schema.json` / `qzone.full.schema.json`。

## 基本内容字段

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| type | 是 | post/comment/reply/album/photo/video/repost |
| owner / author | 是 | 空间归属与实际作者 Actor，不能一律填空间主人 |
| sourceId | 是 | tid、评论/回复 ID、albumId 或媒体 ID |
| createdAt | 是 | Time 或 null；照片按实际上传/拍摄字段意义记录，不混用 |
| content | 是 | 文字、原帖、媒体、语音等完整 Content |
| title | 否 | 相册/媒体等标题 |
| parentId | 条件 | 评论、回复、照片、视频必填，指向父 Record.id |
| repostId | 否 | 原帖 Record.id，与转发者文案分离 |
| replyTo | 否 | 回复对象 Actor |
| counts | 否 | comments/likes/reposts/media 为十进制非负整数字符串或 null；未提供不补零 |

原帖可得时另存 repost 记录，转发帖只引用它。评论、回复是可独立版本化的内容对象，
basic 也保留；正文中的媒体顺序不能由去重后的下载列表代替。相册照片归属保留 parentId，
相同媒体文件在多个相册中出现不等于一个业务条目。

身份分量：账号 + owner 身份 + type + 来源 ID；评论/回复再加所在帖子/父评论。
来源没有稳定评论 ID 时保留持久本地 ID，不能按“名字+正文+时间”跨页无条件去重。

## 基本字段来源映射

QzoneEmotion.tid/content/time 分别映射 sourceId、text 内容、createdAt（秒）；repost
对象拆成原帖并关联 repostId。comments 的 id/parentCommentId/replyId 与帖子身份共同
生成对象键，不把当前 UI 合成的 `${root}_r_${floor}_${uin}` 当成服务端稳定 ID。
uin/nickname 映射 author；replyToUin/replyToNickname 映射 replyTo；images/videos 映射
Content 与 Resource；commentNum/forwardNum/likeCount 映射对应 counts。
QzoneAlbum.id/name/desc/createTime/mediaCount 映射 sourceId/title/文本内容/createdAt/counts.media；
QzoneAlbumPhoto.id/name/desc/uploadTime/isVideo/url/thumbUrl 映射对象身份、标题、内容、
上传时间、媒体类型和各资源变体。代码中评论/点赞 time=0 有“无时间”的占位语义，需回到
原来源区分缺项，转换 null，不能把展示层补出的 0 冒充 1970 年的实际观察。

## 全部数据属性目录

| attributes 名称 | Value 类型 | 来源与意义 |
| --- | --- | --- |
| visibility | json | isPrivate 及可得权限属性，不用它推断未获取内容 |
| likes | json | 实际点赞名单，含身份、来源实际提供的时间及属性；不凭计数造名单 |
| interactionCoverage | json | 评论、回复、赞各自 complete/observed/unobserved/failed/unavailable |
| sourceMedia | json | pic/video/voice/audio 等**未被 Content 和 Resource 表达**的已知属性 |
| albumProperties | json | 相册描述以外的分类、权限、计数等已知属性 |
| mediaProperties | json | 原图/视频/Live Photo 的其他原生属性，不重复资源 URL/尺寸 |
| source.<字段名> | Value | 其他已识别来源字段，按实际类型登记 |

target 默认 `/data`。媒体的实际不同变体各有 Resource；下载后按内容 hash 复用。
只得到视频封面时，封面 role=cover，视频回执仍 missing/unavailable，不将封面冒充视频。
其他未知响应字段进 residual；不得再原样附整页 feeds/comments/likes/details 响应。
分页包装里的计数、游标和未知字段以独立 source 观察关联选中对象；含未选帖的批量响应
须先按对象切分，不能借 full 把其他帖内容附进来。

## 来源与示例

`account/web/qzone.ts`、`qzone_interaction.ts`、`qzone_album.ts` 有正文、媒体、互动和相册
模型；`account/export/qzone_export.ts` 的 nativeMedia、历史 rawPages 与解析 rows 存在信息
重叠。新 full 需在 Web 解析前取得来源字段清单，再按映射拆残余，而非复制 nativeMedia。
当前 JSON/TXT/HTML 和相册索引不符合本设计，JSONL 尚需业务接入。

正例含 post→comment→reply 及 album→photo 关系，full 增加点赞名单。反例：photo 无
parentId、负互动计数、将未取回评论填为空并声称 complete，分别由 schema/语义或未来
来源覆盖验收拒绝；最后一种不能仅凭合成样本证明真实来源完整。
