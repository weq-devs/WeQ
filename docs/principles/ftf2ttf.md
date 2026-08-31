# QQ 私有字体格式 FTF 分析与 TTF 转换

## 1. 为什么要折腾字体格式

中文字体动辄几 MB，而 QQ 的产物里要内置十几种字体（还有各种花体、气泡、MJ 风格），直接原样打包明显不划算。于是拿到字体的第一件事往往是「重新压一遍字形数据」。

FTF 的思路很直接：**整体还是那个 SFNT 容器（标准 TTF 头 + 表目录），大部分表照抄，唯独把描述字形轮廓的 `glyf` 表踢出去**，换成一个同样叫「字形数据」但内容经过私有再编码的 `FTFG` 表 + 一个描述格式参数的 `FTFH` 表。这样：

- 字体文件的其它部分（`cmap`、`hmtx`、`head`、`maxp` 等）浏览器、系统自带的字体引擎还是能读；
- 只有真正「画轮廓」的部分走了私有格式，压缩收益都来自这里。

`font_convert`（`nt_helper/src/font_convert.rs`）做的就是把这份私有轮廓数据**反编码回标准 `glyf` 表**，并顺手修复一堆因魔改导致的“不合规”之处，让你拿到一份干净、可直接被 OTS（OpenType Sanitizer，Chromium 校验依赖它）接受的 TTF。

---

## 2. 怎么认出 FTF

读者可能好奇：一个文件怎么判断是普通 TTF 还是 FTF？看表目录里有没有 `FTFH` / `FTFG` 即可：

```rust
// 遍历表目录 tag，只要出现这两个 tag 之一就是 FTF
fn is_normal_ttf(raw: &[u8]) -> bool {
    // ... 解析表目录 ...
    !has_ftfh && !has_ftfg
}
```

注意两个细节：

- `ftfg` 只出现在 `sfnt`（TrueType 轮廓）字体里；如果是 CFF（`OTTO`）字体，走的是另一套，这里用不上。
- 转换函数对**普通 TTF 并不是原样放行**——`fix_normal_ttf` 仍会扫一遍，把**长度为 0 的空表**删掉（OTS 直接拒绝空表）。所以 `convertFont` 在 FTF 和普通 TTF 上都有意义。

---

## 3. 两张私有表

### 3.1 `FTFH`（FTF Header）——格式参数说明

冗余很少，只读以下几个字段（全是大端）：

| 偏移 | 长度 | 字段 | 说明 |
| ---- | ---- | ---- | ---- |
| 0 | 4 | `version` | 必须是 `0x00010000`，否则直接报 “Unsupported FTFH version”。 |
| 4 | 4 | `num_glyphs` | 字形数量，`loca` 里的索引上限就靠它。 |
| 11 | 1 | `flags` | 高半字节 = `mode1`，低半字节 = `mode2`；两种坐标编码模式，见 §4。 |

`loca` 表依然存在，只是它的偏移不再是「索引到 `glyf`」，而是**索引到 `FTFG` 表里**——`glyf` 长什么样不重要了，`loca` 划出来的每段字节才是某字形在 `FTFG` 里的原始数据。

### 3.2 `FTFG`（FTF Glyph）——私有轮廓数据

每个字形在 `FTFG` 里是一串「子记录（SubRecord）」拼接而成，解析时按字节流顺序读，用**控制位的最高/次高位**区分记录类型。这是全文最核心的部分，放 §5 细讲。

---

## 4. 坐标的两种编码模式

`FTFG` 里的坐标不是定长编码，而是按「组」在**两种模式**间切换，这是压缩的关键：

```rust
fn read_coord(r: &[u8], pos: &mut usize, mode: u8) -> Result<i32> {
    if mode == 1 {
        // 1 字节有符号（i8），省一半空间
        Ok(r[*pos] as i8 as i32)
    } else {
        // 默认 2 字节有符号大端（i16）
        Ok(i16::from_be_bytes([...]) as i32)
    }
}
```

- `mode == 1` → 1 字节；
- 其它值 → 2 字节。

而 `mode1` / `mode2` 决定**哪类坐标**用哪种编码：

- **`mode1`**（高半字节）：用于**组件变换**的系数（§5.2 的 transform 矩阵元素）；
- **`mode2`**（低半字节）：用于**字形轮廓的点坐标**（§5.1 里的每个 `(x, y)`）。

正交组合，让整体可以把数值小、分布集中的那类坐标压成 1 字节，既灵活又能显著省字节。

> 顺带一提：组件里有两个变换元素（dx / dy 平移）固定用 `mode2`，其余用 `mode1`——见 §5.2 的表。

---

## 5. FTFG 字形数据的解码

一个字形在一段字节范围 `[loca[i], loca[i+1])` 内，解析器逐条读头部字节 `b0`：

```
while pos < len:
    b0 = r[pos]                 // 直接用最高位分型
    if b0 & 0x80:
        简单字形记录           // §5.1
    else:
        组件引用（复合字形）    // §5.2
    if b0 & 0x40 == 0:
        break                   // 没有"还有下一条"的标志就结束
```

简记为——最高位 `0x80` = 这是个点记录，次高位 `0x40` = 后面还有记录。

### 5.1 简单字形记录（`b0 & 0x80` 置位）

```
c1   = r[pos+1]                // 基础点数量
c2   = u16[r.pos+2 .. +4]      // 附加点数量
total = c1 + c2
读 total 个 (x, y)，每个坐标走 mode2
读 total 个 flag 字节
if c1 > 0:
    读 c2 个 extra 字节        // 每个附加点对应一个"锚定索引"，见 §5.3
```

这里的关键是 `c1` / `c2` 把点拆成**两组**：

- 前 `c1` 个是**基础点**（base points），直接参与矩阵变换；
- 后 `c2` 个是**附加点**，每个附着一个 `extra[i]` 指向第几个基础点，坐标以「基础点为中心的偏移」存储。

### 5.2 组件引用（`b0 & 0x80` 清除）

复合字形是 TT 一直就有的概念——一个字由若干个「已定义字形（component）」按变换拼出来。FTF 没丢掉这套，只是把每个组件那条记录里的变换写得偏紧凑：

```
nb = b0 & 0x7                       // 子字形 GID 占几字节
child_gid = 大端读 nb 个字节
(m, v6) = read_transform()          // 见下
if v6 & 0x80:
    skip_extended_component()       // 还有一个"扩展组件"头部可跳过
递归解析 child_gid 的轮廓
把 m 合成进每个子记录的链（compose）
```

`read_transform` 用来省字节的小手法值得单独看——它初始矩阵就是 6.6 定点单位阵：

```rust
let mut m = [64, 0, 0, 64, 0, 0, 64];   // Q6.6，对角线 64 == 1.0
let specs = [
    (1,   0, mode1),   // m[0] 用 mode1 读
    (2,   1, mode1),   // m[1]
    (4,   2, mode1),   // m[2]
    (8,   3, mode1),   // m[3]
    (16,  4, mode2),   // m[4] 平移 dx，用 mode2
    (32,  5, mode2),   // m[5] 平移 dy，用 mode2
    (64,  6, mode1),   // m[6] 附加缩放 extra_scale
];
for (bit, idx, mode) in specs:
    if v6 & bit: m[idx] = read_coord(r, pos, mode)?;   // 位没置 1 就用单位默认值
m[4] <<= 6;
m[5] <<= 6;
```

即**对方阵元素、缩放只按需覆盖**——每个变换系数用一个 bit 标记「要不要读」，没标记就用单位矩阵默认值，省掉大量全零/单位字节。矩阵合成 `compose` 就是标准 2×3 仿射乘法，全程 Q6.6 定点（每次乘法结果右移 6）。

因为组件可以嵌套组件，解析用**递归 + 记忆化**（`memo`），并用三态着色（`Unvisited / Visiting / Visited`）做**循环引用检测**——若某个 GID 回溯到它自己，直接报 “Glyph reference cycle detected”，防止死循环。

### 5.3 附加点的锚定技巧（空间换时间）

这是 FTF 里最有意思的压体积思路之一。看 §5.1 的收尾：

```rust
if c1 > 0 {
    let base = 前 c1 个点经矩阵变换后的结果;
    for i in 0..c2 {
        (dx, dy) = points[c1 + i];     // 相对坐标
        ext_idx  = extra[i];           // 锚哪个基础点
        out = base[ext_idx] + (dx * extra_scale >> 6, dy * extra_scale >> 6);
    }
}
```

意思是：**附加点的坐标不直接存绝对坐标，而是「挂在某个基础点上、以它为中心存偏移，再用组件级缩放 extra_scale 放大」**。对字形里大量重复出现的对角/描边细节，只要锚点选得准，每个附加点往往只需 1 字节的相对偏移，空间省得很。

> `extra_scale = m[6]`：组件如果带了缩放系数，附加点的偏移也要跟着缩放，才能和基础点保持一致——这就是为什么变换矩阵里要单独留一个 `m[6]` 给 `extra_scale`。

### 5.4 回到 TTF 网格：坐标翻转与偏移

解码最后一步很关键，它承接了两个字形的坐标系差异：

```rust
const X_OFF: i32 = 128;
const Y_OFF: i32 = 92;
let final_pts = pts.map(|(x, y)| (x + X_OFF, Y_OFF - y));
```

- `x + 128`：把可能为负的横坐标平移到正数区（设计网格似乎以 `(-128..+127)` 为界）；
- `Y_OFF - y`：**Y 轴镜像**。TTF 是 **y 向上** 的左手系（坐标原点在左下），而 FTF 里的原始坐标是 **y 向下** 的位图/描边坐标系；`92 - y` 同时完成翻转 + 平移到 TTF 期望的正区间。

这一步做错，渲染出来的字体会上下颠倒、或整体飘出字体盒。

---

## 6. 输出：重建一份干净的 TTF

拿到每个字形的轮廓点后，`glyf` 表其实就是一个「把多条 SubRecord 摊进单个 TrueType simple glyph」的过程：

1. 把所有点 + 只保留 on-curve 位（`flag & 1`）的 flag 收集起来；遇到 `0x80` 就把当前点记为轮廓终点；
2. 计算 `numberOfContours`、bbox（`xMin/yMin/xMax/yMax`）；
3. 按 TTF simple glyph 的标准**差值编码**写字节：
   - `endPtsOfContours`（起始点索引数组）+ 0 条指令；
   - 每个点的 flag——`xSame`(0x10) / `short+正`(0x02|0x10) / `short+负`(0x02) / 2 字节；
   - x 序列、y 序列。

同一份数据按 `loca` 长格式（4 字节）记 `(num_glyphs + 1)` 个偏移。其余被替换 / 修复的表如下：

| 表 | 处理 |
| ---- | ---- |
| `glyf` / `loca` | **重建**，替换原始（原始 `glyf` 被 FTF 移除、`loca` 指向 `FTFG`） |
| `hmtx` | **重建**：保留每个字形原 `advanceWidth`，令 `leftSideBearing = 新 bbox.xMin` |
| `hhea` | 强制版本 `0x00010000`，`numberOfHMetrics = num_glyphs` |
| `head` | 截到 54 字节，重写**全局 bbox**，`indexToLocFormat = 1`（长 loca）、`glyphDataFormat = 0` |
| `maxp` | 回填 `maxPoints`/`maxContours`；`maxCompositePoints/Contours` 归 0 |
| `cmap` | **重建** format 4 子表，修“多个 0xFFFF 终止段”问题（见 §7） |
| `vhea` / `vmtx` | 版本强制 `0x00010000`；`vmtx` 重建到覆盖全部字形，缺失 side bearing 用最后已知值补齐 |
| `post` | 降到 **3.0 版本**（不写字形名），规避 numGlyphs 不匹配 |
| `gasp` | 版本强制为 1 |
| `FTFH`/`FTFG` 原表 | **全部丢弃** |
| 任何空表 | 丢弃（OTS 不接受空表） |

最后整套写盘前，把 `head.checkSumAdjustment` 按下式计算回填（TTF 的标准校验和约定）：

```rust
let whole = calc_table_checksum(&out);            // 逐 4 字节大端累加整个文件
let check_sum_adj = 0xB1B0AFBAu32.wrapping_sub(whole);
// 写回 head 表偏移 + 8 处
```

---

## 7. 踩过的那些坑（全是 OTS 的脾气）

转换最烦的不是格式解析，而是输出能否过 Chromium 内置的 OTS 校验。代码里每条“修复”背后都有一次真实报错：

- **`cmap: multiple 0xffff terminators found`**：魔改字体常把 format 4 写得好几个 0xFFFF 终止段。解法是把子表**解码成 `(码点 → glyph)` 映射，再重新编码**——连续码点且 glyph 连续的自然段合并成 `idDelta` 段（`idRangeOffset=0`），最后**始终追加恰好一个**纯 `[0xFFFF, 0xFFFF, 1]` 终止段。（顺带做了子表内容去重，防止多个编码记录引用同一份子表造成体积翻倍。）
- **`vmtx: Failed to read side bearing / Failed to parse table`**：OTS 要求 `vmtx` 长度精确等于 `numberOfVMetrics * 4 + (numGlyphs - numberOfVMetrics) * 2`，少了就读崩。重建到覆盖全部字形即可。
- **`vhea: Unsupported table version`**：有魔改把 version 写成 `0x00010001`，强制设回 `0x00010000`。
- **`Changed the version number to 1`（gasp）**：`gasp` 表版本不肯迁就，强制 1。
- **`post` 表 numGlyphs 不匹配**：字体名表条数和字形数对不上，直接降级成 3.0（纯数值、无 glyph 名），最省事也最稳。
- **空表**：OTS 直接拒绝。`fix_normal_ttf` 也要删空表正是这个原因。
- **`indexToLocFormat` / 全局 bbox**：重建后字形布局变了，旧值会误导渲染，必须重算。

> 处理原则一句话：**只改“会影响解析/校验”的表，逆序换掉私有表，尽量少动业务表（`cmap`、`kern`、`GDEF`…），让结果尽量贴近“这份字体本来长什么样”。**

---

## 8. 调用方式

```rust
// nt_helper 的公开入口（NAPI 导出名 convertFont）
#[napi]
pub fn convert_font(input_path: String, output_path: String) -> napi::Result<String>
```

判断逻辑就三个分支：

1. 含 `FTFH`/`FTFG` → 走上面整套 FTF→TTF 重建；
2. 普通 TTF 但带空表 → `fix_normal_ttf` 删空表 + 重算校验和；
3. 什么都没动 → 直接 `fs::copy`，返回 “no issues found, copied as-is”。

返回的字符串会说明到底修了哪类东西，方便上层（如 UI 预览）提示用户。

---

## 9. 小结

- FTF = 标准 TTF 骨架 + 私有 `FTFH`/`FTFG`：**只有字形轮廓被魔改，其余表原样保留**。
- 私有化的三板斧：**可变宽坐标编码**（mode1/mode2，1 或 2 字节）、**组件按需变换**（bit 标记 + Q6.6 定点）、**附加点锚定缩放**（ext 相对偏移 + extra_scale）。
- 还原 = 解析 `FTFG`（简单记录 + 组件递归合成 + 循环检测）→ 送回 TTF 网格（翻转/偏移）→ 重建 `glyf`/`loca` → 修 `cmap`/`vmtx`/`post`/`gasp`/`vhea` 等合规问题 → 重算校验和。
- 最终产物要能过 OTS，才敢喂给浏览器；这一路上“为什么这么改”的答案，几乎都是 OTS 报错文案。

---

## 相关链接

- 源码入口：`nt_helper/src/font_convert.rs`
- 对外接口：`nt_helper.convertFont` — 见 [nt_helper.node 接口文档](../develop/nt-helper-interface.md)

[← 返回原理总览](./index.md)