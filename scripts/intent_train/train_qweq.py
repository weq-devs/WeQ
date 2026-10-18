# -*- coding: utf-8 -*-
"""
QWeQ-NineBird-v1 模型训练与 ONNX 导出脚本
基于轻量级高性能 Chinese RoBERTa (hfl/rbt3) 进行多任务微调：
- 意图分类 (17 类别)
- 情绪分类 (15 类别)
- 情绪强度回归 (0..100)
- 情感极性回归 (-100..100)
全流程在本地 NVIDIA RTX 5070 GPU 上运行，训练完成后自动导出 ONNX。
"""

import json
import os
import sys
import time
import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import Dataset, DataLoader
from transformers import AutoTokenizer, AutoModel, AutoConfig

os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"
os.environ["TOKENIZERS_PARALLELISM"] = "false"

INTENT_LABELS = [
    "question", "request", "greeting", "share", "praise",
    "vent", "joke", "plan", "info", "chat",
    "boast", "flattery", "banter", "perfunctory", "gossip", "coquetry", "other"
]

EMOTION_LABELS = [
    "joy", "excitement", "admiration", "neutral", "sadness",
    "anger", "anxiety", "affection", "fatigue", "curiosity",
    "shock", "aggrieved", "irony", "anticipation", "embarrassed"
]

INTENT2ID = {k: i for i, k in enumerate(INTENT_LABELS)}
EMOTION2ID = {k: i for i, k in enumerate(EMOTION_LABELS)}

class IntentEmotionDataset(Dataset):
    def __init__(self, data_path, tokenizer, max_len=128):
        with open(data_path, "r", encoding="utf-8") as f:
            self.samples = json.load(f)
        self.tokenizer = tokenizer
        self.max_len = max_len

    def __len__(self):
        return len(self.samples)

    def __getitem__(self, idx):
        item = self.samples[idx]
        text = item["formatted_input"]
        encoding = self.tokenizer(
            text,
            max_length=self.max_len,
            padding="max_length",
            truncation=True,
            return_tensors="pt"
        )
        intent_id = INTENT2ID.get(item["intent"], INTENT2ID["other"])
        emotion_id = EMOTION2ID.get(item["emotion"], EMOTION2ID["neutral"])
        intensity = float(item.get("intensity", 50)) / 100.0  # 0..1
        sentiment = (float(item.get("sentiment", 0)) + 100.0) / 200.0  # 0..1 (from -100..100)

        return {
            "input_ids": encoding["input_ids"].squeeze(0),
            "attention_mask": encoding["attention_mask"].squeeze(0),
            "token_type_ids": encoding.get("token_type_ids", torch.zeros_like(encoding["input_ids"])).squeeze(0),
            "intent": torch.tensor(intent_id, dtype=torch.long),
            "emotion": torch.tensor(emotion_id, dtype=torch.long),
            "intensity": torch.tensor(intensity, dtype=torch.float32),
            "sentiment": torch.tensor(sentiment, dtype=torch.float32)
        }

class QWeQNineBirdModel(nn.Module):
    def __init__(self, base_model_name_or_path, num_intents=len(INTENT_LABELS), num_emotions=len(EMOTION_LABELS), dropout=0.2):
        super().__init__()
        self.encoder = AutoModel.from_pretrained(base_model_name_or_path)
        hidden_size = self.encoder.config.hidden_size
        self.dropout = nn.Dropout(dropout)
        
        # 多任务分类与回归头
        self.fc_intent = nn.Sequential(
            nn.Linear(hidden_size, hidden_size // 2),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(hidden_size // 2, num_intents)
        )
        self.fc_emotion = nn.Sequential(
            nn.Linear(hidden_size, hidden_size // 2),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(hidden_size // 2, num_emotions)
        )
        self.fc_intensity = nn.Sequential(
            nn.Linear(hidden_size, 64),
            nn.GELU(),
            nn.Linear(64, 1),
            nn.Sigmoid()
        )
        self.fc_sentiment = nn.Sequential(
            nn.Linear(hidden_size, 64),
            nn.GELU(),
            nn.Linear(64, 1),
            nn.Tanh()
        )

    def forward(self, input_ids, attention_mask=None, token_type_ids=None):
        outputs = self.encoder(
            input_ids=input_ids,
            attention_mask=attention_mask,
            token_type_ids=token_type_ids
        )
        cls_rep = self.dropout(outputs[0][:, 0, :])
        intent_logits = self.fc_intent(cls_rep)
        emotion_logits = self.fc_emotion(cls_rep)
        intensity = self.fc_intensity(cls_rep).squeeze(-1) * 100.0  # 0..100
        sentiment = self.fc_sentiment(cls_rep).squeeze(-1) * 100.0  # -100..100
        return intent_logits, emotion_logits, intensity, sentiment

def train_and_export():
    device = torch.device("cuda:0" if torch.cuda.is_available() else "cpu")
    print(f"[QWeQ-NineBird] Training device: {device}")
    if torch.cuda.is_available():
        print(f"[QWeQ-NineBird] GPU: {torch.cuda.get_device_name(0)}")

    base_model_name = "hfl/rbt3"
    print(f"[QWeQ-NineBird] Loading tokenizer & base model from {base_model_name}...")
    tokenizer = AutoTokenizer.from_pretrained(base_model_name)
    model = QWeQNineBirdModel(base_model_name).to(device)

    data_path = "scripts/intent_train/train_data.json"
    dataset = IntentEmotionDataset(data_path, tokenizer, max_len=128)
    
    # 划分训练集与验证集 (85% / 15%)
    train_size = int(0.85 * len(dataset))
    val_size = len(dataset) - train_size
    train_dataset, val_dataset = torch.utils.data.random_split(
        dataset, [train_size, val_size], generator=torch.Generator().manual_seed(42)
    )

    train_loader = DataLoader(train_dataset, batch_size=16, shuffle=True)
    val_loader = DataLoader(val_dataset, batch_size=16, shuffle=False)
    print(f"[QWeQ-NineBird] Dataset split: train={len(train_dataset)}, val={len(val_dataset)}")

    # 优化器设置（差分学习率）
    encoder_params = [p for n, p in model.encoder.named_parameters()]
    head_params = [
        p for n, p in model.named_parameters() if not n.startswith("encoder.")
    ]
    optimizer = torch.optim.AdamW([
        {"params": encoder_params, "lr": 3e-5, "weight_decay": 0.01},
        {"params": head_params, "lr": 5e-4, "weight_decay": 0.001}
    ])

    epochs = 8
    total_steps = epochs * len(train_loader)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=total_steps)

    ce_loss = nn.CrossEntropyLoss()
    smooth_l1 = nn.SmoothL1Loss()
    scaler = torch.amp.GradScaler('cuda' if torch.cuda.is_available() else 'cpu')

    print("[QWeQ-NineBird] Starting fine-tuning...")
    t0 = time.time()
    for epoch in range(1, epochs + 1):
        model.train()
        total_loss = 0.0
        correct_intent = 0
        correct_emotion = 0
        total_items = 0

        for batch in train_loader:
            optimizer.zero_grad()
            input_ids = batch["input_ids"].to(device)
            attention_mask = batch["attention_mask"].to(device)
            token_type_ids = batch["token_type_ids"].to(device)
            intent_targets = batch["intent"].to(device)
            emotion_targets = batch["emotion"].to(device)
            intensity_targets = batch["intensity"].to(device) * 100.0
            sentiment_targets = (batch["sentiment"].to(device) * 200.0) - 100.0

            with torch.amp.autocast('cuda' if torch.cuda.is_available() else 'cpu'):
                i_logits, e_logits, intensity_pred, sentiment_pred = model(
                    input_ids=input_ids,
                    attention_mask=attention_mask,
                    token_type_ids=token_type_ids
                )
                l_intent = ce_loss(i_logits, intent_targets)
                l_emotion = ce_loss(e_logits, emotion_targets)
                l_intensity = smooth_l1(intensity_pred / 100.0, intensity_targets / 100.0)
                l_sentiment = smooth_l1(sentiment_pred / 100.0, sentiment_targets / 100.0)
                loss = l_intent + l_emotion + 0.5 * l_intensity + 0.5 * l_sentiment

            scaler.scale(loss).backward()
            scaler.step(optimizer)
            scaler.update()
            scheduler.step()

            total_loss += loss.item() * len(input_ids)
            correct_intent += (i_logits.argmax(dim=-1) == intent_targets).sum().item()
            correct_emotion += (e_logits.argmax(dim=-1) == emotion_targets).sum().item()
            total_items += len(input_ids)

        train_loss = total_loss / total_items
        train_acc_i = correct_intent / total_items * 100
        train_acc_e = correct_emotion / total_items * 100

        # 验证评估
        model.eval()
        val_correct_i = 0
        val_correct_e = 0
        val_total = 0
        with torch.no_grad():
            for batch in val_loader:
                input_ids = batch["input_ids"].to(device)
                attention_mask = batch["attention_mask"].to(device)
                token_type_ids = batch["token_type_ids"].to(device)
                intent_targets = batch["intent"].to(device)
                emotion_targets = batch["emotion"].to(device)
                i_logits, e_logits, _, _ = model(input_ids, attention_mask, token_type_ids)
                val_correct_i += (i_logits.argmax(dim=-1) == intent_targets).sum().item()
                val_correct_e += (e_logits.argmax(dim=-1) == emotion_targets).sum().item()
                val_total += len(input_ids)

        val_acc_i = val_correct_i / val_total * 100
        val_acc_e = val_correct_e / val_total * 100
        print(f"Epoch {epoch:02d}/{epochs:02d} | Loss: {train_loss:.4f} | Train Acc: intent={train_acc_i:.1f}%, emotion={train_acc_e:.1f}% | Val Acc: intent={val_acc_i:.1f}%, emotion={val_acc_e:.1f}%")

    print(f"[QWeQ-NineBird] Fine-tuning finished in {time.time() - t0:.2f}s!")

    # 导出模型为 ONNX
    output_dir = "models/QWeQ-NineBird-v1"
    os.makedirs(output_dir, exist_ok=True)
    onnx_path = os.path.join(output_dir, "model.onnx")
    print(f"[QWeQ-NineBird] Exporting ONNX to {onnx_path}...")

    model.eval().to("cpu")
    dummy_input_ids = torch.ones((1, 128), dtype=torch.long)
    dummy_attention_mask = torch.ones((1, 128), dtype=torch.long)
    dummy_token_type_ids = torch.zeros((1, 128), dtype=torch.long)

    torch.onnx.export(
        model,
        (dummy_input_ids, dummy_attention_mask, dummy_token_type_ids),
        onnx_path,
        input_names=["input_ids", "attention_mask", "token_type_ids"],
        output_names=["intent_logits", "emotion_logits", "intensity", "sentiment"],
        dynamic_axes={
            "input_ids": {0: "batch_size", 1: "sequence_length"},
            "attention_mask": {0: "batch_size", 1: "sequence_length"},
            "token_type_ids": {0: "batch_size", 1: "sequence_length"},
            "intent_logits": {0: "batch_size"},
            "emotion_logits": {0: "batch_size"},
            "intensity": {0: "batch_size"},
            "sentiment": {0: "batch_size"}
        },
        opset_version=17,
        do_constant_folding=True,
        dynamo=False
    )
    print(f"[QWeQ-NineBird] ONNX export complete! Size: {os.path.getsize(onnx_path) / (1024 * 1024):.2f} MB")

    # 保存 Tokenizer 和元数据配置文件
    tokenizer_dir = os.path.join(output_dir, "tokenizer")
    os.makedirs(tokenizer_dir, exist_ok=True)
    tokenizer.save_pretrained(tokenizer_dir)

    model_config = {
        "model_name": "QWeQ-NineBird-v1",
        "version": "1.0.0",
        "base_model": "hfl/rbt3",
        "num_parameters": sum(p.numel() for p in model.parameters()),
        "max_length": 128,
        "intent_labels": INTENT_LABELS,
        "emotion_labels": EMOTION_LABELS,
        "exported_at": int(time.time() * 1000)
    }
    with open(os.path.join(output_dir, "model_config.json"), "w", encoding="utf-8") as f:
        json.dump(model_config, f, ensure_ascii=False, indent=2)

    print("[QWeQ-NineBird] Testing ONNX Runtime inference...")
    import onnxruntime as ort
    session = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])
    test_text = "上文[刚刚]: 对方: 我这自研核心算法重构完跑通了，性能提升100倍！ [SEP] 消息: 吓哭了"
    inputs = tokenizer(test_text, max_length=128, padding="max_length", truncation=True, return_tensors="np")
    t_start = time.perf_counter()
    ort_outs = session.run(None, {
        "input_ids": inputs["input_ids"],
        "attention_mask": inputs["attention_mask"],
        "token_type_ids": inputs.get("token_type_ids", np.zeros_like(inputs["input_ids"]))
    })
    latency = (time.perf_counter() - t_start) * 1000

    pred_intent = INTENT_LABELS[np.argmax(ort_outs[0][0])]
    pred_emotion = EMOTION_LABELS[np.argmax(ort_outs[1][0])]
    pred_intensity = float(ort_outs[2][0])
    pred_sentiment = float(ort_outs[3][0])

    print(f"[QWeQ-NineBird] Test Inference:")
    print(f"  Input: {test_text}")
    print(f"  Result: intent={pred_intent}, emotion={pred_emotion}, intensity={pred_intensity:.1f}, sentiment={pred_sentiment:.1f}")
    print(f"  Latency: {latency:.2f} ms")
    print(f"[QWeQ-NineBird] ALL SUCCESSFUL!")

if __name__ == "__main__":
    train_and_export()
