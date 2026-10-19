# 空间分享卡片投影

`renderer/src/lib/qzone.ts` 将已知文字/图片分享 wrapper 投影为标题、封面、描述、来源和 music/link 类型；渲染不插入远端脚本、样式、frame 或播放器。

- 标题和封面可能是相邻节点，不要求图片嵌在链接里；作者正文继续保留。身份链接、图片查看链接与视频 wrapper 不当作分享卡片。
- 相同目的地保留更完整的元信息，后来的普通链接不覆盖；lazy/background 封面仍经过现有资源 URL 校验。
- 封面缺失或失败使用类型图标，不移除目标，不另行抓取目标页面补元数据。
- 已验证的空间身份按现有内部导航打开；其它有效外链使用宿主的校验 opener，未知内部协议不猜目标。

解析和 UI 回归入口：`qzone_card_navigation.test.ts`、`qzone_feed_pictures.test.ts`、`qzone_native.test.ts`。未知服务端 markup 需补匿名样本，不能从展示名称推导真实目标身份。
