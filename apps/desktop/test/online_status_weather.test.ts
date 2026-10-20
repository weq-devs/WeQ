/**
 * 在线状态天气文案（`lib/onlineStatus.ts` 的 `weatherLabel` / `weatherTitle`）的离线单测。
 *
 * 数据来自 misc.db `online_status_kv_table.48902` 的 weather 子结构，不联网、
 * 不碰真 QQ 数据库。跑法：`pnpm --filter @weq/desktop test`。
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { weatherLabel, weatherTitle } from '../src/renderer/src/lib/onlineStatus.ts';

test('城市 + 天气 →「城市 · 天气」', () => {
  assert.equal(
    weatherLabel({ city: '杭州', area: '西湖区', weather: '多云', weatherDesc: '今日多云' }),
    '杭州 · 多云',
  );
});

test('只有天气时只显示天气', () => {
  assert.equal(weatherLabel({ weather: '小雨' }), '小雨');
  assert.equal(weatherLabel({ weatherDesc: '今日有雨' }), '今日有雨');
});

test('空对象 / 空值返回 null（调用方保持原样）', () => {
  assert.equal(weatherLabel({}), null);
  assert.equal(weatherLabel(null), null);
  assert.equal(weatherLabel(undefined), null);
  assert.equal(weatherLabel({ city: '  ', weather: '' }), null);
});

test('字段带空格时去掉首尾空白并压成单个空格', () => {
  assert.equal(weatherLabel({ city: '  杭州 ', weather: ' 多  云 ' }), '杭州 · 多 云');
  assert.equal(weatherLabel({ city: '  ', area: ' 余杭区 ', weather: ' 晴 ' }), '余杭区 · 晴');
});

test('悬停提示补齐城市、区县与天气，去掉重复项', () => {
  assert.equal(
    weatherTitle({ city: '杭州', area: '西湖区', weather: '多云', weatherDesc: '多云' }),
    '杭州 · 西湖区 · 多云',
  );
  assert.equal(weatherTitle({}), null);
  assert.equal(weatherTitle(null), null);
});
