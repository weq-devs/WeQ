<template>
  <div class="weq-tool">
    <p class="weq-tool-title">商城表情密钥计算 / 候选表</p>
    <p class="weq-tool-desc">
      商城表情包的 QQTEA 密钥只有一个来源：<code>md5(String(时间戳))</code> 的前 16 位。
      消息里带着 <code>encryptKey</code> 时直接就有；缺失时就要找回那个时间戳。
    </p>

    <div class="weq-tool-grid">
      <div class="weq-tool-field">
        <label for="mf-ts">时间戳（Unix 秒）</label>
        <input id="mf-ts" v-model="ts" spellcheck="false" placeholder="1696328164" />
      </div>
      <div class="weq-tool-field">
        <label for="mf-window">候选窗口（秒，按上架时间前后展开）</label>
        <input id="mf-window" v-model="window" type="number" min="0" max="600" placeholder="0" />
      </div>
    </div>

    <p class="weq-tool-hint">
      窗口填 0 只算这一个时间戳；填 60 就从「时间戳 − 60」到「时间戳 + 60」逐秒列出候选
      （最多 200 条）。真实场景里 seed 是生成加密 GIF 的那一刻，通常落在包的上架时间附近。
    </p>

    <p v-if="error" class="weq-tool-error">{{ error }}</p>

    <div v-if="direct" class="weq-tool-out">
      <div class="weq-tool-row">
        <span class="weq-tool-key">encryptKey（80824）</span>
        <span class="weq-tool-val">{{ direct.key }}</span>
      </div>
      <div class="weq-tool-row">
        <span class="weq-tool-key">完整 MD5</span>
        <span class="weq-tool-val">{{ direct.full }}</span>
      </div>
      <div class="weq-tool-row">
        <span class="weq-tool-key">公式</span>
        <span class="weq-tool-val">md5("{{ direct.ts }}").slice(0, 16)</span>
      </div>
    </div>

    <div v-if="candidates.length" class="weq-tool-out">
      <p class="weq-tool-desc" style="margin-bottom: 8px">
        逐条试：把下面任意一行的密钥喂给表情包下载链路，能解出 <code>GIF8</code> 开头的就是它。
      </p>
      <div v-for="item in candidates" :key="item.ts" class="weq-tool-row">
        <span class="weq-tool-key">{{ item.ts }}</span>
        <span class="weq-tool-val">{{ item.key }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';
import { md5Hex } from '../utils/digest.ts';

const ts = ref('');
const window = ref('0');
const error = ref('');

const MAX_CANDIDATES = 200;

const direct = computed(() => {
  error.value = '';
  const value = ts.value.trim();
  if (!/^\d+$/.test(value)) {
    if (value) error.value = '时间戳是纯数字的 Unix 秒，别带小数点。';
    return null;
  }
  const full = md5Hex(value);
  return { ts: value, full, key: full.slice(0, 16) };
});

const candidates = computed(() => {
  const base = direct.value;
  const span = Number.parseInt(window.value || '0', 10);
  if (!base || !Number.isFinite(span) || span <= 0) return [];
  const list = [];
  for (let offset = -span; offset <= span && list.length < MAX_CANDIDATES; offset += 1) {
    const value = String(Number(base.ts) + offset);
    list.push({ ts: value, key: md5Hex(value).slice(0, 16) });
  }
  return list;
});
</script>
