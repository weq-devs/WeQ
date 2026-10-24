# 视频编码：`t265`（QQ 自带魔改 x265）

> 2026-10-25。本端视频编码的逆向记录。**当前状态：编码器可初始化，编码一帧仍崩溃**。

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

## 8. 当前卡点

初始化全部正确（自检行显示 `Res[640x360] fps[15.0] key[30] q[26] bit[400] rc[1]`），
lowres 阶段也通过了，但**编码主体阶段崩溃**：

```
t265_copy_pp_32x32_avx2
  ← TEncCu::loadCtuForSingleThread
    ← TEncRow::compressRowSingleThread
      ← TEncFrame::compressFrame
        ← TEncTop::encode(t265_inpic_tag*, t265_outpic_tag*)
          ← t265_encoder_encode
```

崩溃时 `rdi`（目标缓冲，编码器内部 `m_picOrg`）地址无效。

推测原因（待验证）：

1. `t265_inpic_tag` 还有字段没填（`colorSpace` / `bitDepth` 等）
2. 应走 `T265Enc::DoEncode` 而非直接调 `t265_encoder_encode` ——
   `DoEncode` 会做额外的格式转换与内部缓冲准备

## 9. 下一步

用 IDA 看 `T265Enc::DoEncode`（`0xd7b020`）的完整实现，确认它比直接调底层多做了
哪些准备，然后照抄。`T265Enc::ConfigParam` 里已经看到它用
`malloc(0x2F8)` 分配了 `t265_outpic_tag`，说明输出图结构也要预分配。

## 10. Windows

`AVSDKPlugin.dll` **不导出符号**（Opus 那边就是靠日志字符串锚点 + 字节扫描
找入口的）。所以 Windows 上连函数地址都要先扫，结构体布局只能纯逆向。

不过 **Windows 版的 `T265Enc` 类结构与 Linux 一致**（已用 IDA 反编译
`T265Enc::Encode` / `Open` 对照过，字段偏移相同），所以 Linux 版调通后
Windows 只需解决"怎么拿到函数地址"。
