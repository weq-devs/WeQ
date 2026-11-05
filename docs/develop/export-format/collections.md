# 收藏

历史 QQ 收藏 bizKey/qzoneUgcKey/topTime 的登记属性见[历史兼容契约](historical.md)。
它们不替代 CID；topTime=0 不证明有置顶历史。空间收藏是 qzone/type=favorite，不混入此领域。

状态：待实现设计。入口：`collection.basic.schema.json` / `collection.full.schema.json`。

## 基本内容字段

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| cid / type | 是 | CID；text/link/gallery/audio/video/file/location/richMedia/unknown |
| author | 是 | 作者 Actor；不能从展示文案拆猜 UIN |
| origin | 否 | 原私聊/群等 Conversation，只填来源实际可证实的字段 |
| createdAt / collectedAt | 是 | Time 或 null，创建与收藏时间分别保留 |
| title | 否 | 独立标题 |
| bodyStatus | 是 | complete/summary/truncated/opaque/unknown |
| content | 是 | 完整 Content；实际只有摘要时如实记录，不填“全文已获取” |

身份分量为账号 + CID。八种内容分别处理：文本保存正文；链接保存地址、独立摘要及发布者；
gallery 保存有序图片；audio 保存音频资源、时长和已有转写；video 保存视频与封面；
file 保存文件引用；location 保存经纬度、地址及备注；richMedia 保存全文及其内嵌资源。
链接、位置等使用 structured Value，不能只用格式化的一列字符串。

本地 180001→cid、180002→type/typeCode、180004→author/origin、180009→createdAt、
180010→collectedAt、180015→Content；详情来自 content_list_info_table 或缓存详情。
当前 CollectionItem 的 createTime/collectTime 被导出层按毫秒显示，新提取器应对原整数
用十进制定点换算，不能先转 Number 再除 1000。网络字段按各自接口已核实单位换算，
nativeModifyTime/sequence 不沿用格式化字符串的猜测。单位无法核实时用 null 与 residual。

同一段详情已有完整文本时，不再复制相同摘要；如果摘要是来源独立写入且内容不同，则
保留为 source-summary 类型内容或独立来源版本，记录实际关系。HTML 原正文和清理后
展示结果不同时当作原始数据保存。opaque 详情必须有唯一 bytes/text 内容或 full residual。

## 全部数据属性目录

| attributes 名称 | Value 类型 | 来源 |
| --- | --- | --- |
| typeCode | integer | 本地 180002 与网络类型值，不能将未知类型改写为 0 |
| modifiedAt | json | 180012/网络修改时间规范化 Time；无法解释则保留 residual |
| sequence | integer/text | 网络 sequence，按实际编码，不经 Number 截断 |
| authorProperties | json | 180004 中除已映射身份、群归属之外的属性 |
| contentProperties | json | 180015 各类型中的额外已知属性 |
| detailProperties | json | content_list_info_table/网络详情中额外已知字段 |
| source.<字段名> | Value | 其他已识别列及缓存属性 |

target 默认 `/data`；附件额外属性放 Resource.native。原始 md5/sha1、文件句柄、保存路径
线索等有实际信息时也保存，但不把历史本机路径当可访问的包内路径。未知列、tag、错误
wire type、尾部填充及未解析详情保留为 residual。不得同时导出整个 author/content BLOB
和其已解析字段。批量详情按 CID 拆分，不向精确 CID 导出夹带整账号原始响应。

## 来源与示例

`packages/db/src/collection/collection.ts` 已识别 PicInfo/FileInfo/Author 等丰富字段；
`assemble.ts` 当前只组装 schema 字段，尾部和未知 tag 没有进入 CollectionExportRow。
`account/collection_detail_store.ts` / `collection_history.ts` 保存 raw 批次与详情；
`account/export/collection_export.ts` 的行已拍平且注明丢弃 blob，不能承担 full 输入。

合成正例覆盖八类及 unknown，full 有 sequence 与未知详情片段。反例包括缺 CID、把
未知正文默认为 complete、原始片段与已知映射重叠；后两者还需要覆盖契约及来源夹具验证。
