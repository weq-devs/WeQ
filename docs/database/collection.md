# collection.db — QQ 收藏

QQ 收藏功能的本地库。核心表 `collection_list_info_table`，
一行 = 一条收藏（文本 / 链接 / 图片 / 音视频 / 文件 / 位置 / 富媒体）。

对应 WeQ 解析实现：

| 文件 | 职责 |
| ---- | ---- |
| `packages/db/src/collection/collection.ts` | 取行 + 两列 protobuf → `CollectionItem` |
| `packages/db/src/collection/assemble.ts` | 宽容的 schema 驱动 protobuf 装配器 |
| `packages/codec/src/proto/collection/index.ts` | 180004 / 180015 两列的 wire schema |

---

## 一、`collection_list_info_table`

| 列 | 字段名 | 类型 | 含义 | 置信度 |
| -- | ------ | ---- | ---- | ------ |
| 180001 | `cid` | TEXT | 收藏 id，形如 `1-1-<uuid>` | 已验证 |
| 180002 | `type` | INTEGER | 内容类型 1~8，见下表 | 已验证 |
| 180009 | `createTime` | INTEGER | 内容创建时间（**毫秒**） | 已验证 |
| 180010 | `collectTime` | INTEGER | 收藏时间（毫秒），**列表排序键** | 已验证 |
| 180012 | `modifyTime` | INTEGER | 最后修改时间（毫秒） | 已验证 |
| 180004 | `author` | BLOB | protobuf：收藏来源（谁发的/哪个群） | 已验证 |
| 180015 | `content` | BLOB | protobuf：内容摘要，按 type 的 tagged union | 已验证 |

注意三个时间都是**毫秒**（消息库里 40050 是秒，别串）。

`type` 枚举：

| 值 | kind | 内容 |
| -- | ---- | ---- |
| 1 | text | 纯文本 |
| 2 | link | 链接（url/标题/摘要/配图） |
| 3 | gallery | 图片集 |
| 4 | audio | 音频（时长/语音转文字 stt） |
| 5 | video | 视频 |
| 6 | file | 文件 |
| 7 | location | 位置 |
| 8 | richMedia | 富媒体（公众号文章等） |

## 二、两个 protobuf 列

两列各自把真正的 body 套在同名列号下（与 recent-contact 预览同款习惯）：

```text
180004 (BLOB) → { 180004: AuthorInfo }      作者/来源
180015 (BLOB) → { 180015: CollectionContent } 内容 union
```

`AuthorInfo`：群 id/群名、uid、numId/strId 等 —— 回答「这条收藏是从哪条会话存的」。

`CollectionContent` 是 tagged union，`type` 决定哪个字段有值：

- `textSummary.text`
- `linkSummary`：url / title / publisher / brief / picList
- `gallerySummary.picList`
- `audioSummary`：duration / **stt（语音转文字）** / extra
- `videoSummary`：title / duration / 预览图 / 存储文件信息
- `fileSummary`：fileInfo（名称/大小/md5/本地路径 savePath）
- `locationSummary`：名称/经纬度/地址/note
- `richMediaSummary`：title / brief / originalUri / picList

图片描述 `CollectionPicInfo`：uri（资源句柄）、md5/sha1、宽高、savePath。

## 三、宽容解码（assemble.ts）

收藏的 protobuf 有个坑：**部分 body（尤其是 location）尾部带一串 `0x00` 填充**。
严格 protobuf 解码器把它读成 field-number-0 的 tag 直接抛错 —— 而 QQ 自己和
napcat 都容忍。简单裁掉尾部也不行：length 前缀把填充算在长度里，
与「合法的空 LEN 尾字段」无法区分。

WeQ 的解法是 schema 驱动的宽容装配器：

1. 用 `@weq/codec/raw` 的宽容 walker 解出原始字段树（wire 不合理处直接停）；
2. 按 `ProtoField` schema 的 tag 把字段树映射回具名、带类型的输出；
3. 对尾部填充和未知字段天然免疫。

```ts
decodeMessage(bytes, CollectionContentColumn).content  // → CollectionContent
```

## 四、表可能不存在

**QQ 只在这台机器上打开过一次收藏面板后才会建 `collection.db` 和这张表**。
此前文件缺失或为空 —— 语义是「没有收藏」，不是错误。
所以读取前先查 `sqlite_master`，表不存在时 `count`/`listAll` 返回 0/空数组而非抛错。

常见查询（WeQ 的读法）：

```sql
SELECT "180001","180002","180009","180010","180012","180004","180015"
FROM collection_list_info_table
ORDER BY "180010" DESC   -- 最新收藏在前
LIMIT ? OFFSET ?;
```

---

[← 返回数据库分析](./index.md)
