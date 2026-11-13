<template>
  <div class="weq-tool">
    <p class="weq-tool-title">商城表情本地图片解密</p>
    <p class="weq-tool-desc">
      QQ 把商城表情缓存到 <code>nt_data/Emoji/marketface/&lt;itemId&gt;/&lt;hash&gt;</code>。
      无扩展名的那个文件是 XOR 混淆过的 GIF：<b>每 50 字节一块，块内前 20 字节和 0xFF
      异或</b>，其余原样。这一步不需要任何密钥，本地就能解。
    </p>

    <div class="weq-tool-field">
      <label for="mf-file">选择缓存文件（无扩展名的那个）</label>
      <input id="mf-file" type="file" @change="onFile" />
    </div>

    <p class="weq-tool-hint">
      同一目录里还有 <code>&lt;hash&gt;_aio.png</code>、<code>&lt;hash&gt;_thu.png</code>
      这类明文 PNG。它们是<b>已经解密好</b>的，选进来会直接原样显示，不要再 XOR 一遍。
    </p>

    <p v-if="error" class="weq-tool-error">{{ error }}</p>

    <div v-if="rows.length" class="weq-tool-out">
      <div v-for="row in rows" :key="row.key" class="weq-tool-row">
        <span class="weq-tool-key">{{ row.key }}</span>
        <span class="weq-tool-val">{{ row.value }}</span>
      </div>
      <div v-if="previewUrl" class="weq-tool-row">
        <span class="weq-tool-key">预览</span>
        <span class="weq-tool-val">
          <img class="weq-tool-img" :src="previewUrl" alt="解密结果预览" />
          <a :href="previewUrl" :download="downloadName" class="weq-tool-btn" style="display: inline-block; margin-top: 10px">
            下载解密后的图片
          </a>
        </span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onBeforeUnmount, ref } from 'vue';

const rows = ref([]);
const error = ref('');
const previewUrl = ref('');
const downloadName = ref('marketface.gif');

function sniff(bytes) {
  const head = String.fromCharCode(...bytes.slice(0, 6));
  if (head.startsWith('GIF8')) return 'gif';
  if (bytes[0] === 0x89 && head.slice(1, 4) === 'PNG') return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg';
  return 'unknown';
}

/** 每 50 字节一块，块内前 20 字节异或 0xFF。 */
function deobfuscate(bytes) {
  const out = new Uint8Array(bytes.length);
  for (let offset = 0; offset < bytes.length; offset += 50) {
    const size = Math.min(50, bytes.length - offset);
    const head = Math.min(20, size);
    for (let i = 0; i < head; i += 1) out[offset + i] = bytes[offset + i] ^ 0xff;
    out.set(bytes.subarray(offset + head, offset + size), offset + head);
  }
  return out;
}

function release() {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value);
  previewUrl.value = '';
}

onBeforeUnmount(release);

async function onFile(event) {
  release();
  rows.value = [];
  error.value = '';
  const file = event.target.files?.[0];
  if (!file) return;

  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = sniff(bytes);
  let result = bytes;
  let action = '原样显示（本来就是明文）';
  let finalKind = kind;

  if (kind === 'unknown') {
    result = deobfuscate(bytes);
    action = '按 50/20 规则 XOR 解密';
    const after = sniff(result);
    finalKind = after;
    if (after === 'unknown') {
      error.value =
        '解密后仍然认不出图片格式：可能是别的加密方式（例如 CDN 的 QQTEA 流），也可能是选错了文件。';
      rows.value = [
        { key: '文件名', value: file.name },
        { key: '大小', value: `${bytes.length} 字节` },
        {
          key: '原始头',
          value: Array.from(bytes.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join(' '),
        },
      ];
      return;
    }
    rows.value.push({ key: '识别结果', value: `XOR → ${after.toUpperCase()}` });
  } else if (kind !== 'unknown') {
    error.value = '';
    rows.value.push({ key: '识别结果', value: `明文 ${kind.toUpperCase()}` });
  }

  downloadName.value = `marketface.${finalKind}`;
  previewUrl.value = URL.createObjectURL(new Blob([result]));
  rows.value.unshift(
    { key: '文件名', value: file.name },
    { key: '大小', value: `${bytes.length} 字节` },
    { key: '处理方式', value: action },
  );
}
</script>
