<template>
  <div class="weq-tool">
    <p class="weq-tool-title">Android / iOS 数据库密钥计算</p>
    <p class="weq-tool-desc">
      手机 QQ 的库口令可以<b>完全离线</b>算出来：输入是账号 uid 和库头部那段叫
      <code>rand</code> 的 8 位可打印字符串，不需要 root、不需要越狱、也不用 hook。
    </p>

    <div class="weq-tool-grid">
      <div class="weq-tool-field">
        <label for="android-uid">nt_uid</label>
        <input
          id="android-uid"
          v-model="uid"
          spellcheck="false"
          placeholder="u_mIicAReWrdCB-kST6TXH7A"
          @input="compute"
        />
      </div>
      <div class="weq-tool-field">
        <label for="android-rand">rand（8 位）</label>
        <input id="android-rand" v-model="rand" spellcheck="false" placeholder="6tPaJ9GP" @input="compute" />
      </div>
    </div>

    <p class="weq-tool-hint">
      <code>rand</code> 在 <code>nt_msg.db</code> 前 1024 字节私有头里，紧跟
      <code>QQ_NT DB</code> 标记之后，是明文可读的一小段字符。
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
import { md5Hex } from '../utils/digest.ts';

const uid = ref('');
const rand = ref('');
const error = ref('');

const rows = computed(() => {
  error.value = '';
  const id = uid.value.trim();
  const r = rand.value.trim();
  if (!id && !r) return [];
  if (id && !/^u_[A-Za-z0-9_-]{1,64}$/.test(id)) {
    error.value = 'nt_uid 一般是 `u_` 开头的字符串，注意别填成 QQ 号。';
  }
  if (r && r.length !== 8) {
    error.value = 'rand 是 8 个可打印字符，长度不对多半是复制多了或少了一位。';
  }
  if (!id || !r) return [];

  const uidHash = md5Hex(id);
  const pathHash = md5Hex(`${uidHash}nt_kernel`);
  const key = md5Hex(`${uidHash}${r}`);
  return [
    { key: 'QQ_UID_hash', value: uidHash },
    { key: '账号目录', value: `nt_qq_${pathHash}` },
    { key: '数据库密钥', value: key },
    { key: '公式', value: 'md5(md5(uid) + rand)' },
  ];
});
</script>
