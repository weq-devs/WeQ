<template>
  <div class="weq-tool">
    <p class="weq-tool-title">设备 guid 预测</p>
    <p class="weq-tool-desc">
      QQ 的 <code>guid</code> 是设备标识，由本机几个固定值离线算出来。知道公式就能反推：
      改了机器标识、或者想确认某台机器上的 guid 到底是哪来的，都不用再摸内存。
    </p>

    <div class="weq-tool-grid">
      <div class="weq-tool-field">
        <label for="guid-platform">平台</label>
        <select id="guid-platform" v-model="platform">
          <option value="linux">Linux</option>
          <option value="darwin">macOS</option>
        </select>
      </div>
      <div v-if="platform === 'linux'" class="weq-tool-field">
        <label for="guid-mid">/etc/machine-id 内容</label>
        <input
          id="guid-mid"
          v-model="machineId"
          spellcheck="false"
          placeholder="32 位十六进制，保留文件末尾的换行"
        />
      </div>
      <div v-if="platform === 'linux'" class="weq-tool-field">
        <label for="guid-mac">machine-info 里的 MAC</label>
        <input
          id="guid-mac"
          v-model="mac"
          spellcheck="false"
          placeholder="52-54-00-f9-07-2d 或粘贴 machine-info 的 hex"
        />
      </div>
      <div v-if="platform === 'darwin'" class="weq-tool-field">
        <label for="guid-mid8">machine_id（8 字节 hex）</label>
        <input id="guid-mid8" v-model="machineId8" spellcheck="false" placeholder="0102030405060708" />
      </div>
      <div v-if="platform === 'darwin'" class="weq-tool-field">
        <label for="guid-sn">序列号（sn）</label>
        <input id="guid-sn" v-model="serial" spellcheck="false" placeholder="C02XXXXXXXXX" />
      </div>
    </div>

    <p v-if="platform === 'linux'" class="weq-tool-hint">
      <code>machine-info</code> 是 <code>be32(len) + ROT13(MAC 字符串)</code>，不是加密。
      直接粘那串 hex 也行，下面会自动转成 MAC。注意 <code>/etc/machine-id</code>
      的换行也参与 MD5。
    </p>
    <p v-else class="weq-tool-hint">
      macOS 的 <code>machineid-info</code> 是 TEA 容器（key 取 <code>IOPlatformUUID</code>
      前 16 字节），解开后是 <code>be32(8) + machine_id[8] + be32(len) + sn</code>。
      滚动栏里记不下的号在 <code>WeQ</code> 里可以用「读取 / 重置设备 guid」一步完成。
    </p>

    <p v-if="error" class="weq-tool-error">{{ error }}</p>

    <div v-if="rows.length" class="weq-tool-out">
      <div v-for="row in rows" :key="row.key" class="weq-tool-row">
        <span class="weq-tool-key">{{ row.key }}</span>
        <span class="weq-tool-val">{{ row.value }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';
import { md5, toHex } from '../utils/digest.ts';

const platform = ref('linux');
const machineId = ref('');
const mac = ref('');
const machineId8 = ref('');
const serial = ref('');
const error = ref('');

const encoder = new TextEncoder();

/** `machine-info` 的解析：be32 长度 + ROT13。粘 hex 或明文 MAC 都能处理。 */
function normalizeMac(input) {
  const raw = input.trim();
  if (!raw) return { mac: '', note: '' };
  if (/^[0-9a-fA-F\s]{8,}$/.test(raw) && raw.replace(/\s/g, '').length % 2 === 0) {
    const bytes = new Uint8Array(
      raw
        .replace(/\s/g, '')
        .match(/../g)
        .map((h) => parseInt(h, 16)),
    );
    if (bytes.length >= 4) {
      const len = new DataView(bytes.buffer).getUint32(0, false);
      if (len > 0 && 4 + len <= bytes.length) {
        const body = bytes.slice(4, 4 + len);
        const text = String.fromCharCode(
          ...body.map((c) =>
            c >= 0x41 && c <= 0x5a
              ? ((c - 0x41 + 13) % 26) + 0x41
              : c >= 0x61 && c <= 0x7a
                ? ((c - 0x61 + 13) % 26) + 0x61
                : c,
          ),
        );
        return { mac: text, note: '已按 be32 + ROT13 解析 machine-info' };
      }
    }
  }
  return { mac: raw, note: '' };
}

const rows = computed(() => {
  error.value = '';
  if (platform.value === 'linux') {
    const mid = machineId.value;
    const parsed = normalizeMac(mac.value);
    if (!mid || !parsed.mac) return [];
    if (!/^[0-9a-f]{8,}$/i.test(parsed.mac.replace(/-/g, '')) && parsed.mac.length < 6) {
      error.value = 'MAC 看起来不对，正常形如 52-54-00-f9-07-2d。';
      return [];
    }
    const guid = md5(new Uint8Array([...encoder.encode(mid), ...encoder.encode(parsed.mac)]));
    return [
      { key: 'guid', value: guid },
      { key: 'machine-id 字节', value: `${encoder.encode(mid).length} 字节（含换行则计入）` },
      { key: 'MAC', value: parsed.mac + (parsed.note ? `（${parsed.note}）` : '') },
      { key: '公式', value: 'md5(machine-id 原文 ‖ MAC)' },
    ];
  }

  const mid8 = machineId8.value.trim();
  const sn = serial.value.trim();
  if (!mid8 || !sn) return [];
  if (!/^[0-9a-f]{16}$/i.test(mid8)) {
    error.value = 'machine_id 是 8 字节，也就是 16 位十六进制。';
    return [];
  }
  const midBytes = new Uint8Array(mid8.match(/../g).map((h) => parseInt(h, 16)));
  const guid = md5(new Uint8Array([...midBytes, ...encoder.encode(sn)]));
  return [
    { key: 'guid', value: guid },
    { key: 'machine_id', value: toHex(midBytes) },
    { key: 'sn', value: sn },
    { key: '公式', value: 'md5(machine_id[8] ‖ sn)' },
  ];
});
</script>
