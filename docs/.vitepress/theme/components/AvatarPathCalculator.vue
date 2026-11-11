<template>
  <div class="weq-tool">
    <p class="weq-tool-title">头像缓存路径预测</p>
    <p class="weq-tool-desc">
      QQ 不按 QQ 号保存头像文件，文件名是 uid 的三次 MD5。填 uid 就能直接算出
      缓存文件该落在哪一层目录，不必再把整个 <code>nt_data/avatar</code> 扫一遍。
    </p>

    <div class="weq-tool-grid">
      <div class="weq-tool-field">
        <label for="avatar-uid">账号 / 好友 uid</label>
        <input
          id="avatar-uid"
          v-model="uid"
          spellcheck="false"
          placeholder="u_LKt3AdAIMP-CUfn6ydzDzw"
          @input="onInput"
        />
      </div>
      <div class="weq-tool-field">
        <label for="avatar-scope">作用域</label>
        <select id="avatar-scope" v-model="scope" @change="onInput">
          <option value="user">user（好友 / 陌生人）</option>
          <option value="group">group（群）</option>
          <option value="cover">cover（资料卡封面）</option>
        </select>
      </div>
    </div>

    <p class="weq-tool-hint">
      群的 uid 就是群的数字群号，直接填群号即可；<code>cover</code> 用资料卡封面的
      uid，公式与好友一致。
    </p>

    <p v-if="error" class="weq-tool-error">{{ error }}</p>

    <div v-if="hash" class="weq-tool-out">
      <div class="weq-tool-row">
        <span class="weq-tool-key">头像 hash</span>
        <span class="weq-tool-val">{{ hash }}</span>
      </div>
      <div class="weq-tool-row">
        <span class="weq-tool-key">分桶目录</span>
        <span class="weq-tool-val">{{ scope }}/{{ bucket }}/</span>
      </div>
      <div class="weq-tool-row">
        <span class="weq-tool-key">大图</span>
        <span class="weq-tool-val">nt_data/avatar/{{ scope }}/{{ bucket }}/b_{{ hash }}</span>
      </div>
      <div class="weq-tool-row">
        <span class="weq-tool-key">缩略图</span>
        <span class="weq-tool-val">nt_data/avatar/{{ scope }}/{{ bucket }}/s_{{ hash }}</span>
      </div>
      <div class="weq-tool-row">
        <span class="weq-tool-key">Linux 扁平布局</span>
        <span class="weq-tool-val">nt_data/avatar/{{ scope }}/b_{{ hash }}</span>
      </div>
      <div class="weq-tool-row">
        <span class="weq-tool-key">公式</span>
        <span class="weq-tool-val">md5(md5(md5(uid) + uid) + uid)</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { md5Hex } from '../utils/digest.ts';

const uid = ref('');
const scope = ref('user');
const bucket = ref('');
const hash = ref('');
const error = ref('');

/** 与 `avatarHashForUid()` 完全一致：三次 MD5，每次把 hex 串和 uid 拼起来。 */
function onInput() {
  const value = uid.value.trim();
  hash.value = '';
  bucket.value = '';
  error.value = '';
  if (!value) return;
  if (/\s/.test(value)) {
    error.value = 'uid 里不应该有空白字符。';
    return;
  }
  hash.value = md5Hex(md5Hex(md5Hex(value) + value) + value);
  bucket.value = hash.value.slice(0, 2);
}
</script>
