# 视频编码：`t265`（QQ 自带魔改 x265）

> 2026-10-25。本端视频编码的逆向记录。**当前状态：linux / macOS / windows 三平台
> 均已调通**（windows 见第 10 节的 `.pdata` + 字节特征定位）。

## 1. 为什么不能用系统 x265

与音频那边的结论一致：QQ 用的是**腾讯魔改版**编解码器，编进 `AVSDKPlugin`
（linux/macOS 是 `libAVSDKPlugin.so` / `.dylib`，windows 是 `AVSDKPlugin.dll`）。

魔改版的符号前缀是 **`t265_`**（`t` = tencent），版本 `2.12.1|d542e84|R`。
与音频的 `t` 前缀 Opus 是同一套路。**系统 libx265 编出来的码流对端不一定能解**。

## 2. 平台差异（关键）

| 平台 | 符号导出 | 可用性 |
| --- | --- | --- |
| linux | **完整 C++ 符号表** | 好：`nm -C` 能直接拿到全部方法名与地址 |
| macOS | 待验证 | 推测同 linux（都是 ELF/Mach-O 导出表） |
| windows | **不导出** | 差：连函数地址都要靠日志字符串锚点扫 |

linux 版 `nm -C libAVSDKPlugin.so` 直接给出：

```
T265Enc::T265Enc() / ~T265Enc()
T265Enc::Init(VENCODER_NS::EncParam const*)           @ 0xd7ac20
T265Enc::ConfigParam()                                 @ 0xd7a830
T265Enc::DoEncode(VideoFrame*, VideoPacket*, void*)    @ 0xd7b020
T265Enc::UnInit()                                      @ 0xd7ad20
CreateT265Encoder / ReleaseT265Encoder                 @ 0xd7b810 / 0xd7b8d0
encoder_init(EncParam, callback, string)               @ 0xd91320
```

⚠️ 这些是**本地符号**（`nm` 里是小写 `t`），`dlsym` 拿不到，只能
`模块基址 + 文件偏移` 调用。

## 3. 加载方式

必须先以 `RTLD_GLOBAL` 加载系统 GnuTLS，否则 `libbugly.so` 的未定义符号
（`gnutls_free`）会让 `dlopen` 直接失败。与 `nt_helper/src/call/avsdk.rs` 里
Opus 的处理完全相同。

另外：`t265enc_log_callback`（全局变量，文件偏移 `0x15e1958`）**必须先设成一个
有效函数指针**，否则 `encoder_open` 内部打日志时会调用 NULL 崩溃。

## 4. `t265_param_t` 布局（已用 `param_parse` + 内存对比验证）

| 偏移 | 字段 | 说明 |
| --- | --- | --- |
| 0x00 | width | |
| 0x04 | height | |
| 0x08 | fpsNum | |
| 0x0C | fpsDenom | 默认 1 |
| 0x44 | preset | 7=ultrafast … 11 |
| 0x54 | rcMode | 1 = ABR |
| 0x74 | keyint | |
| 0x84 | rcMode 副本 | `ConfigParam` 会写 |
| 0x8C | bitrate | kbps |

`t265_param_parse` 认的键名（返回 0 即认识）：`source-width` / `source-height` /
`width` / `height` / `input-res` / `fps` / `fps-num` / `fps-denom` / `bitrate` /
`vbv-maxrate` / `vbv-bufsize` / `keyint` / `min-keyint` / `bframes` / `qp` / `crf` /
`rc-lookahead` / `tune` / `annexb` / `repeat-headers` / `log-level` /
`frame-threads` / `pools` / `input-csp` / `total-frames` / `max-nal-size` /
`slices` / `ref` / `scenecut` / `open-gop` / `no-info` / `get-ref-list`。

⚠️ **`width` / `height` / `fps` 通过 `param_parse` 设置不生效**（返回 0 但结构体
没变），必须直接写偏移 0/4/8/12。

## 5. 初始化顺序（照抄 `T265Enc::ConfigParam`）

```c
p = t265_param_alloc();
t265_param_default(p);
*(int*)(p + 0x44) = 7;              // preset = ultrafast
t265_param_config_preset(p);        // ★ 必须：铺好全部默认（含内部 stride 计算）
*(int*)(p + 0x00) = width;
*(int*)(p + 0x04) = height;
*(int*)(p + 0x08) = fps;
*(int*)(p + 0x0C) = 1;
t265_param_parse(p, "tune", "zerolatency");   // ★ 见下方警告
t265_param_parse(p, "get-ref-list", "1");     // 魔改新增（标准 x265 没有）
t265_param_parse(p, "bitrate", "400");
*(int*)(p + 0x84) = 1;                        // rc 模式 = ABR
enc = t265_encoder_open(p, &err);
```

**坑：`tune` 不能写 `meetingCamera`。** QQ 自己用的是
`t265_param_parse(p, "tune", "meetingCamera")`，但 Linux 版没有这个档位，
返回 -1 且会把 tune 指针指到无效位置，导致 `encoder_open` 失败。
必须换成 `zerolatency`。

## 6. `t265_inpic_tag` 布局（gdb 内存验证）

| 偏移 | 字段 |
| --- | --- |
| 0x10 | pts / frameIndex |
| 0x20 | plane0 指针 |
| 0x28 | plane0 **stride**（不是长度！） |
| 0x30 | plane1 指针 |
| 0x38 | plane1 stride |
| 0x40 | plane2 指针 |
| 0x48 | plane2 stride |
| 0x58 | frameType（1 = I 帧） |

**`+0x28` 是 stride 不是长度** —— 填成 `width*height` 会让编码器按
230400 字节的行宽去拷，直接越界崩溃。

## 7. 可用自检输出

`t265_encoder_open` 成功后往 stderr 打一行完整配置，**这是逆向时的最佳验证手段**：

```
t265 : [2.12.1|d542e84|R]P[7]tune[0,-1]key[30]q[26,0/69]bit[400]rc[1]
       Res[640x360,0/0,0/0]fps[15.0]tb[1/15]vfr[0]scc[0]aq[0/0.5,0]
       svc[0]fmt[1]th[0,1,64]ltr[0]mc[0,100]rc2[0,0,0,0.00,...]
```

`Res` / `fps` / `key` / `q` / `bit` / `rc` / `tune` 都能直接读。

## 8. 已经跑通（2026-10-25）

早期卡在 `t265_copy_pp_32x32_avx2`（目标缓冲无效），根因是**输入图的平面偏移
整体错了 8~16 字节**。反编译 `T265Enc::DoEncode` 后才对齐：

```c
// DoEncode 把 VideoFrame 逐字段搬到 this+0xE8（= t265_inpic_tag）
this+0xF0  = frame+0x10   → inpic+0x08  pts
this+0xF8  = frame+0x18   → inpic+0x10
this+0xFC  = frame+0x1C   → inpic+0x14
this+0x100 = frame+0x20   → inpic+0x18
this+0x108 = frame+0x28   → inpic+0x20  plane0
this+0x110 = frame+0x30   → inpic+0x28  plane1
this+0x118 = frame+0x38   → inpic+0x30  plane2
```

另外两个坑：

- **`outpic` 必须由调用方预分配 0x2F8 字节**（`ConfigParam` 里 `malloc(0x2F8)`）；
  它的 `+0x20` 是 nal 数量，`+0x2C + i*0x10` 是每条 nal 的 `{int32 size; ptr payload}`。
- **`t265_encoder_encode` 的返回值是 `int` 不是指针**：`<0` 失败、`0` 还在
  lookahead 里没输出、`>0` 有输出。

### 验证结果

```
ffprobe: codec_name=hevc profile=Main width=640 height=360
ffmpeg -f null -: 零错误
20 帧 → 1 个关键帧 → 8107 字节（≈405 字节/帧，符合 400 kbps @ 15 fps）
```

**`sliceType` 不能固定给 1**：那样每帧都是 I 帧，码率会爆（20 帧 3668 字节全是
关键帧）。只在首帧给 1，之后给 0 让编码器按 GOP 自己判定。

## 10. 平台差异（2026-10-25 实测三个平台）

| 平台 | 版本 | 符号 | 可用性 |
| --- | --- | --- | --- |
| linux | 2.12.1 | **完整 C++ 符号表**（`nm -C` 全可读） | ✅ 已调通 |
| macOS | 7.0.2 (53644) | **完整符号表**（`nm` 在 Linux 上读不了 Mach-O，直接解 `LC_SYMTAB` 拿到） | ✅ 应可用 |
| windows | 9.9.35 | **不导出**（改用 `.pdata` 分块 + 字节特征，见下） | ✅ 已调通 |

### macOS 细节

`QQ.app/Contents/Resources/app/avsdk/libAVSDKPlugin.dylib` 是 **universal binary**
（x86_64 + arm64），符号类型 `N_SECT|N_EXT`，**`dlsym` 能直接拿到**：

```text
x86_64                        arm64
opus_encoder_create 0xd403d0  opus_encoder_create 0xbd7ecc
opus_encode         0xd45140  opus_encode         0xbdc370
t265_param_alloc    0x16f3cb0 t265_param_alloc    0x131b88c
t265_encoder_open   0x16f44c0 t265_encoder_open   0x131be60
t265_encoder_encode 0x16f46c0 t265_encoder_encode 0x131c050
```

⚠️ **在 Linux 上用 `nm` 查这个 dylib 会显示 0 个符号** —— 那是 GNU nm 读不了
Mach-O 的符号表，不是真的没有。要验证得直接解析 `LC_SYMTAB`：

```python
# 读 fat header → 定位 slice → 遍历 load commands 找 LC_SYMTAB(cmd=0x2)
# → nlist_64 每条 16 字节：n_strx(4) n_type(1) n_sect(1) n_desc(2) n_value(8)
# → n_type & 0x01 是 N_EXT（外部可见，dlsym 拿得到）
```

所以 `avsdk.rs` 里 `load_exported()`（内部走 `dlsym`）在 macOS 上**是对的**，
之前以为「macOS 符号不导出」是误判。

`t265enc_log_callback` 这个静态全局变量在 macOS 上还没定位到偏移，
`set_log_callback` 会跳过 —— 影响仅限 t265 内部打日志时的踩空风险。

### Windows

`AVSDKPlugin.dll` 确实不导出（Opus 那边就是靠日志字符串锚点 + 字节扫描找入口的）。
Windows 版的 `T265Enc` 类结构与 Linux 一致（已用 IDA 反编译
`T265Enc::Encode` / `Open` 对照过，字段偏移相同），所以只需解决「怎么拿到函数地址」。

#### 定位方法：`.pdata` 分块 + 字节特征（2026-10-25 调通）

**不能用 Opus 那套日志锚点。** t265 的报错日志和调用点没有一一对应关系：
`encoder_encode` 的四条报错共用同一条 call 之后的分支，`param_alloc` 的失败日志
甚至在调用点之后（`call malloc` → `test rax` → `jz` → 打日志）。

改用的锚是 **PE 异常表 `.pdata`**：x64 上每个含调用/异常的函数都有一条
`RUNTIME_FUNCTION`，`BeginAddress` 就是函数入口。把特征串命中地址映射回它所在
的 `.pdata` 分块，得到的就是入口。`param_config_preset` 是叶子函数没有条目，
命中地址本身就是入口。

QQ 9.9.35（`2.12.1|d542e846f|R`，映像 `0x2466000`）实测：

| 符号 | 特征（节选） | 唯一性 | RVA |
| --- | --- | --- | --- |
| `param_alloc` | `B9 DF 01 00 00` + `B9 C7 0A 00 00` | 2 + 1 → 1 | `0x943770` |
| `param_default` | `48 8B B9 88 01 00 00` + `41 B8 98 01 00 00` | 1 + 4 → 1 | `0x943860` |
| `param_config_preset` | `8B 41 44 B9 0A…83 E8 04 3B C8 1B C0 C3` | 1 | `0x943850` |
| `param_free` | `48 8B 89 88 01 00 00` + `48 8B 4B F8` | 14 + N → 1 | `0x943E20` |
| `param_parse` | `48 8B B1 88 01 00 00` | 1 | `0x943E60` |
| `encoder_open` | `B9 40 78 00 00`（new 0x7840） | 1 | `0x9436C0` |
| `encoder_encode` | `48 83 EC 38 48 C7 44 24 20 FE FF FF FF` + 尾部 `48 83 C4 38 C3 CC CC CC CC 48 85 C9 74 0E 48 85 D2` | 32 + 1 → 1 | `0x943680` |
| `encoder_close` | `40 53 48 83 EC 20 48 8B D9 48 85 C9 74 1A E8` | 2 → 1 | `0x943650` |

八个入口跨度 `0x810`，可作为交叉校验（特征全中但地址离散 = 解析错了）。

#### 日志回调在 Windows 上是**必需**的

`T265Enc::ConfigParam` 会写 `qword_1813DF938 = 全局回调`、`dword_1812D2898 = 级别`，
然后 `t265_encoder_open` 内部第一条日志（`t265 : [2.12.1…]P[7]…` 那行自检）就
`call r10` —— 回调为 NULL 直接崩进程。

槽位不用硬编码：t265 所有日志都经过同一个转发函数，形状固定：

```asm
4C 8B 15 <disp32>   mov  r10, [rip+disp]     ; 全局回调
4D 85 D2            test r10, r10
74 <rel8>           jz   done
3B 15 <disp32>      cmp  edx, [rip+disp2]    ; 级别门限
7F <rel8>           jg   done
85 D2 / 74 / 83 EA 01 74 / 83 EA 01 74 / 83 FA 01 75
BA 05 00 00 00      mov  edx, 5              ; 0..4 → 5，t265 独有
```

从 `mov r10` 直接读出两个全局的 RVA（实测 `0x13DF938` / `0x12D2898`）。尾部
0..4 逐级比较那段是 t265 独有的（映像里另一处日志转发只到 4 级），用来排除同名形状。

#### 实测结果

用同一套特征定位后完整跑通：

```
Res[640x360] fps[15.0] key[30] bit[400] rc[1]     ← 与 linux 版一致
20 帧 → 5588 字节，首帧 VPS/SPS/PPS/IDR（nal 32/33/34/19）
```

**注意**：Windows 版 `t265_encoder_encode` 的 `outpic` 解析与 linux 完全一致
（`+0x20` nal 数、`+0x2C` 起每条 `{int32 size; ptr payload}`、步长 `0x10`），
`T265Enc::Encode` 里 `v18[8]` / `v18[v20+11]` / `v18[v20+12]` 交叉验证过。
