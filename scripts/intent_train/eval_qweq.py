# -*- coding: utf-8 -*-
import json
import numpy as np
import onnxruntime as ort
from transformers import AutoTokenizer

cfg = json.load(open('models/QWeQ-NineBird-v1/model_config.json', 'r', encoding='utf-8'))
tok = AutoTokenizer.from_pretrained('models/QWeQ-NineBird-v1/tokenizer')
sess = ort.InferenceSession('models/QWeQ-NineBird-v1/model.onnx')

cases = [
    # 1. 刚刚对方炫耀成果 -> 吓哭了 => 赞叹/夸赞
    ('上文[刚刚]: 对方: 我刚刚自研的核心算法重构全通过了，性能飙升10倍！', '吓哭了，这也太强了吧！'),
    # 2. 刚才对方生病难受 -> 吓哭了 => 焦虑/担忧/难过
    ('上文[刚刚]: 对方: 昨晚突然高烧到40度，心跳特别快差点休克', '吓哭了，赶紧去医院看看啊！'),
    # 3. 玩梗大笑
    ('', '哈哈哈哈笑死我了，夺笋呐！'),
    # 4. 吹捧
    ('上文[刚刚]: 对方: 我们的方案被技术委员会评为年度最佳实践！', '大佬受我一拜，仙品细糠！'),
    # 5. 损友调侃
    ('上文[刚刚]: 对方: 刚单抽直接出金出专武，帅不帅？', '就这啊？你小子差不多得了！'),
    # 6. 久远失效上下文 (超过10分钟久远) -> 吓哭了 不应被误判为成果赞叹
    ('上文[久远]: 对方: 上周打通关了一个游戏', '吓哭了，刚才路上好大一只蟑螂飞我身上了')
]

for ctx, text in cases:
    full = f"{ctx} [SEP] 消息: {text}" if ctx else f"消息: {text}"
    inputs = tok(full, max_length=128, padding='max_length', truncation=True, return_tensors='np')
    feeds = {k: inputs[k] for k in ['input_ids', 'attention_mask', 'token_type_ids']}
    outs = sess.run(None, feeds)
    intent_idx = np.argmax(outs[0][0])
    emotion_idx = np.argmax(outs[1][0])
    intensity = float(np.squeeze(outs[2]))
    sentiment = float(np.squeeze(outs[3]))
    print(f"Text: {text}")
    print(f"  Ctx: {ctx if ctx else '(无)'}")
    print(f"  -> Intent: {cfg['intent_labels'][intent_idx]}, Emotion: {cfg['emotion_labels'][emotion_idx]}, Intensity: {intensity:.1f}, Sentiment: {sentiment:.1f}")
    print("-" * 50)
