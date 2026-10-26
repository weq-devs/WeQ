/**
 * 临时排查工具：解析 HEVC SPS 的 VUI 色彩字段。
 *
 * 用途：验证「Windows 前 15 秒偏绿」是否与码流里声明/未声明色彩信息有关。
 *
 * 用法：
 *   WEQ_CALL_VIDEO_DUMP=/tmp/vdump pnpm --filter @weq/desktop dev
 *   通话后：npx tsx tmp_hevc_vui.ts /tmp/vdump/encoded.h265
 */

import { readFileSync } from 'node:fs';

interface Nal {
  type: number;
  data: Uint8Array;
}

function splitHevcNals(data: Uint8Array): Nal[] {
  const nals: Nal[] = [];
  let i = 0;
  let start = -1;
  while (i < data.length) {
    const four =
      i + 4 <= data.length &&
      data[i] === 0 &&
      data[i + 1] === 0 &&
      data[i + 2] === 0 &&
      data[i + 3] === 1;
    const three =
      !four && i + 3 <= data.length && data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1;
    if (four || three) {
      if (start >= 0) {
        const body = data.subarray(start, i);
        if (body.length >= 2) nals.push({ type: (body[0]! >> 1) & 0x3f, data: body });
      }
      start = i + (four ? 4 : 3);
      i = start;
      continue;
    }
    i++;
  }
  if (start >= 0 && start < data.length) {
    const body = data.subarray(start);
    if (body.length >= 2) nals.push({ type: (body[0]! >> 1) & 0x3f, data: body });
  }
  return nals;
}

function removeEmulationPrevention(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  let n = 0;
  for (let i = 0; i < data.length; i++) {
    if (i + 2 < data.length && data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 3) {
      out[n++] = 0;
      out[n++] = 0;
      i += 2;
      continue;
    }
    out[n++] = data[i]!;
  }
  return out.subarray(0, n);
}

class BitReader {
  private pos = 0;
  constructor(private readonly data: Uint8Array) {}
  bit(): number {
    if (this.pos >> 3 >= this.data.length) throw new Error('bit read past end');
    const b = (this.data[this.pos >> 3]! >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return b;
  }
  u(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.bit();
    return v;
  }
  ue(): number {
    let zeros = 0;
    while (this.bit() === 0) {
      zeros++;
      if (zeros > 32) throw new Error('ue too long');
    }
    return (2 ** zeros - 1) + this.u(zeros);
  }
  se(): number {
    const k = this.ue();
    return k & 1 ? (k + 1) / 2 : -(k / 2);
  }
  get bitsLeft(): number {
    return this.data.length * 8 - this.pos;
  }
  skip(n: number): void {
    this.pos += n;
  }
  get position(): number {
    return this.pos;
  }
}

/** HEVC 的 profile_tier_level 解析，返回占用的位数。 */
function parseProfileTierLevel(bits: BitReader, maxSubLayersMinus1: number): void {
  bits.skip(2 + 1 + 5); // general_profile_space / tier_flag / profile_idc
  bits.skip(32); // general_profile_compatibility_flags
  bits.skip(48); // general_constraint_indicator_flags
  bits.skip(8); // general_level_idc
  const profilePresent: boolean[] = [];
  const levelPresent: boolean[] = [];
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    profilePresent.push(bits.bit() === 1);
    levelPresent.push(bits.bit() === 1);
  }
  if (maxSubLayersMinus1 > 0) {
    for (let i = maxSubLayersMinus1; i < 8; i++) bits.skip(2); // reserved_zero_2bits
  }
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    if (profilePresent[i]) bits.skip(2 + 1 + 5 + 32 + 48);
    if (levelPresent[i]) bits.skip(8);
  }
}

const COLOR_PRIMARIES: Record<number, string> = {
  1: 'BT.709',
  2: 'Unspecified',
  4: 'BT.470M',
  5: 'BT.470BG',
  6: 'SMPTE170M',
  7: 'SMPTE240M',
  8: 'Film',
  9: 'BT.2020',
  10: 'SMPTE428',
  11: 'SMPTE431',
  12: 'SMPTE432',
  22: 'EBU3213',
};

const TRANSFER: Record<number, string> = {
  1: 'BT.709',
  2: 'Unspecified',
  4: 'Gamma 2.2',
  5: 'Gamma 2.8',
  6: 'SMPTE170M',
  7: 'SMPTE240M',
  8: 'Linear',
  9: 'Log100',
  10: 'Log316',
  11: 'IEC61966-2-4',
  12: 'BT.1361E',
  13: 'IEC61966-2-1 (sRGB)',
  14: 'BT.2020 10bit',
  15: 'BT.2020 12bit',
  16: 'SMPTE2084 (PQ)',
  17: 'SMPTE428',
  18: 'HLG',
};

const MATRIX: Record<number, string> = {
  0: 'GBR (identity)',
  1: 'BT.709',
  2: 'Unspecified',
  4: 'FCC',
  5: 'BT.470BG',
  6: 'SMPTE170M',
  7: 'SMPTE240M',
  8: 'YCgCo',
  9: 'BT.2020 NCL',
  10: 'BT.2020 CL',
  11: 'SMPTE2085',
  12: 'Chroma-derived NCL',
  13: 'Chroma-derived CL',
  14: 'ICtCp',
};

interface VuiInfo {
  present: boolean;
  videoSignalTypePresent?: boolean;
  videoFormat?: number;
  videoFullRangeFlag?: number;
  colourPrimaries?: number;
  transferCharacteristics?: number;
  matrixCoeffs?: number;
  chromaLocInfoPresent?: boolean;
  parsedBits?: number;
}

function parseSpsVui(rbsp: Uint8Array): {
  width: number;
  height: number;
  chromaFormat: number;
  bitDepthLuma: number;
  bitDepthChroma: number;
  vui: VuiInfo;
  error?: string;
} {
  const bits = new BitReader(rbsp);
  const result = {
    width: 0,
    height: 0,
    chromaFormat: -1,
    bitDepthLuma: -1,
    bitDepthChroma: -1,
    vui: { present: false } as VuiInfo,
  };
  try {
    bits.skip(4); // sps_video_parameter_set_id
    const maxSubLayersMinus1 = bits.u(3);
    bits.skip(1); // sps_temporal_id_nesting_flag
    parseProfileTierLevel(bits, maxSubLayersMinus1);

    bits.ue(); // sps_seq_parameter_set_id
    const chromaFormat = bits.ue();
    result.chromaFormat = chromaFormat;
    if (chromaFormat === 3) bits.skip(1); // separate_colour_plane_flag
    result.width = bits.ue();
    result.height = bits.ue();
    if (bits.bit() === 1) {
      // conformance_window_flag
      bits.ue();
      bits.ue();
      bits.ue();
      bits.ue();
    }
    result.bitDepthLuma = bits.ue() + 8;
    result.bitDepthChroma = bits.ue() + 8;
    const log2MaxPoc = bits.ue() + 4;
    const subLayerOrdering = bits.bit();
    if (subLayerOrdering) {
      for (let i = 0; i <= maxSubLayersMinus1; i++) {
        bits.ue();
        bits.ue();
        bits.ue();
      }
    }
    bits.ue(); // log2_min_luma_coding_block_size_minus3
    bits.ue(); // log2_diff_max_min_luma_coding_block_size
    bits.ue(); // log2_min_luma_transform_block_size_minus2
    bits.ue(); // log2_diff_max_min_luma_transform_block_size
    bits.ue(); // max_transform_hierarchy_depth_inter
    bits.ue(); // max_transform_hierarchy_depth_intra
    void log2MaxPoc;

    if (bits.bit() === 1) {
      // scaling_list_enabled_flag
      if (bits.bit() === 1) {
        // sps_scaling_list_data_present_flag
        for (let sizeId = 0; sizeId < 4; sizeId++) {
          for (let matrixId = 0; matrixId < 6; matrixId += sizeId === 3 ? 3 : 1) {
            if (bits.bit() === 0) {
              bits.ue(); // scaling_list_pred_matrix_id_delta
            } else {
              const coefNum = Math.min(64, 1 << (4 + (sizeId << 1)));
              if (sizeId > 1) bits.se(); // scaling_list_dc_coef_minus8
              for (let i = 0; i < coefNum; i++) bits.se();
            }
          }
        }
      }
    }
    bits.skip(1); // amp_enabled_flag
    bits.skip(1); // sample_adaptive_offset_enabled_flag
    if (bits.bit() === 1) {
      // pcm_enabled_flag
      bits.skip(4 + 4); // pcm_sample_bit_depth_luma/chroma_minus1
      bits.ue(); // log2_min_pcm_luma_coding_block_size_minus3
      bits.ue(); // log2_diff_max_min_pcm_luma_coding_block_size
      bits.skip(1); // pcm_loop_filter_disabled_flag
    }
    const numShortTermRps = bits.ue();
    if (numShortTermRps > 64) throw new Error(`sps short term rps 异常: ${numShortTermRps}`);
    for (let i = 0; i < numShortTermRps; i++) {
      const interRefPicSetPrediction = i !== 0 ? bits.bit() : 0;
      if (interRefPicSetPrediction) throw new Error('inter_ref_pic_set_prediction 未实现');
      const numNegative = bits.ue();
      const numPositive = bits.ue();
      for (let j = 0; j < numNegative + numPositive; j++) {
        bits.ue(); // delta_poc_sX_minus1
        bits.skip(1); // used_by_curr_pic_sX_flag
      }
    }
    if (bits.bit() === 1) {
      // long_term_ref_pics_present_flag
      const numLongTerm = bits.ue();
      for (let i = 0; i < numLongTerm; i++) {
        bits.skip(log2MaxPoc);
        bits.skip(1);
      }
    }
    bits.skip(1); // sps_temporal_mvp_enabled_flag
    bits.skip(1); // strong_intra_smoothing_enabled_flag
    const vuiPresent = bits.bit();
    result.vui.present = vuiPresent === 1;
    if (vuiPresent !== 1) return result;

    const vui: VuiInfo = { present: true };
    if (bits.bit() === 1) {
      // aspect_ratio_info_present_flag
      const idc = bits.u(8);
      if (idc === 255) bits.skip(32);
    }
    if (bits.bit() === 1) bits.skip(1); // overscan_info_present_flag + overscan_appropriate
    if (bits.bit() === 1) {
      // video_signal_type_present_flag
      vui.videoSignalTypePresent = true;
      vui.videoFormat = bits.u(3);
      vui.videoFullRangeFlag = bits.bit();
      if (bits.bit() === 1) {
        // colour_description_present_flag
        vui.colourPrimaries = bits.u(8);
        vui.transferCharacteristics = bits.u(8);
        vui.matrixCoeffs = bits.u(8);
      }
    } else {
      vui.videoSignalTypePresent = false;
    }
    if (bits.bit() === 1) {
      // chroma_loc_info_present_flag
      vui.chromaLocInfoPresent = true;
      bits.ue();
      bits.ue();
    }
    vui.parsedBits = bits.position;
    result.vui = vui;
    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    return result;
  }
}

function analyze(path: string): void {
  const raw = new Uint8Array(readFileSync(path));
  const nals = splitHevcNals(raw);
  console.log(`文件: ${path}  共 ${raw.length} 字节 / ${nals.length} 个 NAL\n`);

  const counts = new Map<number, number>();
  for (const nal of nals) counts.set(nal.type, (counts.get(nal.type) ?? 0) + 1);
  console.log('NAL 类型分布:');
  for (const [type, n] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
    const name =
      type === 32 ? 'VPS' : type === 33 ? 'SPS' : type === 34 ? 'PPS' : type <= 21 ? 'IRAP/VCL' : '';
    console.log(`  type=${type}${name ? ` (${name})` : ''} × ${n}`);
  }

  // 逐帧列出关键帧的位置和 SPS
  let frameIndex = 0;
  let seenSps = 0;
  for (const nal of nals) {
    if (nal.type === 33) {
      seenSps++;
      const rbsp = removeEmulationPrevention(nal.data.subarray(2));
      const sps = parseSpsVui(rbsp);
      console.log(`\n=== 第 ${seenSps} 个 SPS（NAL 序号 ${frameIndex}，${nal.data.length} 字节）===`);
      if (sps.error) {
        console.log(`  解析中断: ${sps.error}`);
      }
      console.log(
        `  分辨率 ${sps.width}x${sps.height}  chroma=${sps.chromaFormat}  bitDepth=${sps.bitDepthLuma}/${sps.bitDepthChroma}`,
      );
      const v = sps.vui;
      if (!v.present) {
        console.log('  ❌ VUI 不存在 —— 码流未声明任何色彩信息');
      } else {
        console.log('  VUI 存在');
        if (v.videoSignalTypePresent === false) {
          console.log('  ❌ video_signal_type_present_flag = 0 —— 未声明色彩空间');
        } else if (v.videoSignalTypePresent) {
          console.log(`  video_format=${v.videoFormat}  full_range=${v.videoFullRangeFlag}`);
          if (v.colourPrimaries === undefined) {
            console.log('  ❌ colour_description_present_flag = 0 —— 未声明 primaries/transfer/matrix');
          } else {
            console.log(
              `  colour_primaries=${v.colourPrimaries} (${COLOR_PRIMARIES[v.colourPrimaries] ?? '?'})`,
            );
            console.log(
              `  transfer_characteristics=${v.transferCharacteristics} (${TRANSFER[v.transferCharacteristics!] ?? '?'})`,
            );
            console.log(`  matrix_coeffs=${v.matrixCoeffs} (${MATRIX[v.matrixCoeffs!] ?? '?'})`);
          }
        }
      }
    }
    if (nal.type <= 31) frameIndex++;
  }
}

const path = process.argv[2];
if (!path) {
  console.error('用法: npx tsx tmp_hevc_vui.ts <encoded.h265>');
  process.exit(1);
}
analyze(path);
