# 资源目录与文件清单

状态：待实现设计。入口：`resource-directory.basic.schema.json` / `resource-directory.full.schema.json`。
历史附件绑定、SILK→WAV 等播放副本及 TAR/CAS 定位见[历史兼容契约](historical.md#资源与派生)。
文件已 saved 不会把 candidate/unresolved 绑定自动升级为 verified。
资源文件和取得回执的公共 schema 见 [common](common.md)。

| data 字段 | 必填 | 含义 |
| --- | --- | --- |
| type | 是 | folder/file/album/photo/video/emoji-pack/emoji/bubble/font/widget/artifact/report/bot-package |
| sourceId / owner / name | 是 | 稳定资源目录身份、归属 Actor、原名称 |
| resourceIds | 是 | Resource ID 数组，目录可空；不是仅成功文件列表 |
| parentId | 否 | 父目录/相册/表情包 Record.id，保留层级 |
| createdAt / description | 否 | 来源实际时间或 null、描述 |

身份分量是账号+归属（groupCode/空间 UIN/资源 owner）+type+来源稳定 ID；文件的目录
位置关系不能仅通过本机文件名恢复。群文件相同名字可在不同 folderId，重名不覆盖。
空间相册优先用 qzone 类型保留内容语义；资源目录用于群相册/文件、表情/装扮及通用
文件清单，同一业务对象不同时生成两套正文。

full.native.attributes 默认 target=`/data`，目录登记如下。

| 名称 | Value 类型 | 含义 |
| --- | --- | --- |
| size / total / unread / price / version | integer/text | 来源大小、数量、邮箱目录状态、价格、资源版本；按实际类型 |
| locked / available / downloaded | boolean | 来源状态，不从本地是否存在推断在线可用 |
| uploader / permissions / classification | json | 来源上传者、权限属性与分类 |
| properties / source.<字段名> | Value | 已识别其他属性，不装入一份重复原始响应 |

文件级 native 保留来源 hash、句柄、变体及其他属性；未知目录/资源字段进 residual。
商城目录不等于已下载文件，视频封面不算视频原件；独立清单引用路径和真实 SHA 分开结算。
原文件的实际字节只在 media 中存一次。已存的预览/缩略图也是不同变体，full 不能只保留
下载器挑中的“最佳地址”而丢弃其他缓存内容；是否复制实际文件仍由附件选项决定。

来源：统一资源任务的 resource-results、群文件/相册服务、emoji_export、favorite_emoji_export、
dress_export、qzone_albums、generated_resources 等。逐项接入状态见覆盖矩阵。报告与机器人
部署包只映射已有文件清单及元数据，不承诺还原生成环境、不把运行认证加入通用附件清单。

正例含父目录、文件、表情包、装扮和失败资源引用；反例：saved 没有 hash、包外路径、
同一内容 hash 指向不同文件字节。最后一种需真实文件校验，schema 不会读取文件。
