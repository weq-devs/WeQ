# 联系人、群与成员

状态：待实现设计。统一入口：`directory.schema.json`；basic/full 仅为导出内容范围。

| data 字段 | 必填 | 含义 |
| --- | --- | --- |
| type / subject / name | 是 | contact/group/member/category；Actor；名称原值 |
| remark | 否 | 独立备注，不用备注替换昵称 |
| parentId | 成员必填 | 群 Record.id；category 可使用父分类 |
| categoryIds | 否 | 分类 Record.id 数组 |
| role | 否 | 来源提供的角色，不按名单顺序推断 |
| avatarResources | 否 | 已声明头像 Resource ID 数组 |

身份分量：账号+type+UID/UIN；群使用 groupCode，成员再加所属 groupCode；分类使用分类
ID 而非名称。群身份也用 namespace=source，value 标明 `group:<code>`，不伪装成用户 UIN。
名单导出 basic 不自动夹带全个人资料；名称/备注及群成员关系仍足够直接分析。

full.native.attributes 的 target 默认 `/data`，按下列目录保存已知其余信息。

| 名称 | Value 类型 | 来源 |
| --- | --- | --- |
| signature / country / province / city | text | 好友资料原值，不重复写已派生的拼接 region |
| gender / age / birthYear / birthMonth / birthDay | integer | 原字段，未知不猜生日 |
| intimacy / albumCount | integer | 缓存统计 |
| privileges / education / interests | json/text | 尽量保留来源结构，现有平铺字符串只作旧来源 |
| memberCount / maxMembers | integer | 群目录统计 |
| ownerUid / createdAt / leftFlag | text/json/integer | 群主 UID、Time、原离群标记 |
| joinedAt / lastSpeakAt / level / muteUntil | json/json/integer/json | 成员真实缓存字段，时间规范化 |
| source.<字段名> | Value | 其他已识别数据库列、资料和缓存属性 |

真实没有提供的字段缺席；未知列及 BLOB 残余进入 residual。照片或头像元数据不是一份
新联系人，不重复发出业务记录；实际资源使用独立 Resource。群目录不等于在线在群名单。

来源：`account/export/contacts_export.ts` 的 FriendRow、MemberRow、GroupDirectoryRow；
底层 `packages/db/src/profile/buddy.ts`、`group_info` 模块及资料服务需逐字段补接。现有表格格式化的
地区、生日、特权不能替代原结构。正例包含 contact/group/member/category；反例：成员
没有 parentId、UIN/UID 混用，以及重复 native.name 覆盖 data.name。
