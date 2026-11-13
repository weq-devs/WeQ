<template>
  <div class="weq-tool">
    <p class="weq-tool-title">gpro（QQ 频道）数据库密钥计算</p>
    <p class="weq-tool-desc">
      频道库 <code>gpro_v1-6_&lt;uid&gt;.db</code> 用的是另一套派生：输入换成
      <b>QQ 号</b>（不是 uid）和库头部前 16 个字符，公式比消息库多折了两层。
    </p>

    <div class="weq-tool-grid">
      <div class="weq-tool-field">
        <label for="gpro-uin">QQ 号（uin）</label>
        <input id="gpro-uin" v-model="uin" spellcheck="false" placeholder="1707889225" @input="compute" />
      </div>
      <div class="weq-tool-field">
        <label for="gpro-header">头部盐值（16 字符）</label>
        <input
          id="gpro-header"
          v-model="header"
          spellcheck="false"
          placeholder="vgdBdzWwwrNNGORk"
          @input="compute"
        />
      </div>
    </div>

    <p class="weq-tool-hint">
      盐值在库文件开头 1024 字节私有头里，是明文可读的 16 个字符。注意频道库的
      文件名带 uid，但参与运算的是 QQ 号。
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
import { computed, ref, watchEffect } from 'vue';
import { md5, md5Hex, sha1Raw } from '../utils/digest.ts';

const uin = ref('');
const header = ref('');
const error = ref('');
const key = ref('');
const seeds = ref({});

watchEffect(async () => {
  const account = uin.value.trim();
  const salt = header.value.trim();
  error.value = '';
  key.value = '';
  seeds.value = {};
  if (!account && !salt) return;
  if (account && !/^\d+$/.test(account)) {
    error.value = 'QQ 号必须是一串纯数字。';
    return;
  }
  if (salt && salt.length !== 16) {
    error.value = '盐值是 16 个字符，长度不对就是读错了位置。';
    return;
  }
  if (!account || !salt) return;

  // sha1 取的是「原始 20 字节」，不是 hex —— 这一步弄错就永远对不上。
  const md5Uin = md5Hex(account);
  const md5Sha1 = md5(await sha1Raw(account));
  const userSeed = md5Hex(`${md5Uin}${md5Sha1}`);
  const headerSeed = md5Hex(salt);
  const final = md5Hex(`${headerSeed}${userSeed}`);
  seeds.value = { md5Uin, md5Sha1, userSeed, headerSeed };
  key.value = final;
});

const rows = computed(() => {
  if (!key.value) return [];
  return [
    { key: 'gpro 密钥', value: key.value },
    { key: 'md5(uin)', value: seeds.value.md5Uin },
    { key: 'md5(sha1_原始字节(uin))', value: seeds.value.md5Sha1 },
    { key: 'user_seed', value: seeds.value.userSeed },
    { key: 'header_seed', value: seeds.value.headerSeed },
    { key: '公式', value: 'md5(md5(header) + md5(md5(uin) + md5(sha1(uin))))' },
    { key: '页 / KDF HMAC', value: 'HMAC_SHA512 / PBKDF2_HMAC_SHA512' },
  ];
});
</script>
