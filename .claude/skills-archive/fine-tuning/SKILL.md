---
name: fine-tuning
description: Use whenever the user wants to fine-tune YOLOv8 on top of existing pretrained weights — including the overnight run before the Friday demo and any future improvement cycles. Covers starting fine-tuning from a checkpoint (not from scratch), keeping the previous model as fallback, exporting to ONNX for the web app, and side-by-side evaluation. Trigger on phrases like "fine-tune", "improve the model", "train on top of", "retrain overnight", "export to ONNX", or any request to make the detection model better.
---

# Fine-Tuning YOLOv8

## What this is (and isn't)
- **Fine-tuning** = start from already-trained weights, train a bit more on our dataset. Fast, almost always better than training from scratch.
- **NOT training from scratch.** We do not do that anymore. The 30-epoch from-scratch run was abandoned for a reason.

## Golden rules
1. **Never overwrite the current production model.** Fine-tuned output goes to a *new* file. The previous model stays untouched as a fallback.
2. **Always export to ONNX** at the end. The web app cannot use raw `.pt` files.
3. **Always evaluate side-by-side** before declaring the new model better. "Loss went down" is not enough.
4. **Always use `caffeinate`** for any run longer than 20 minutes. (See `training-runs` skill.)

## Starting a fine-tuning run

```bash
caffeinate -i nohup python training/finetune.py \
    --weights training/checkpoints/pretrained.pt \
    --data data/smoking_litter.yaml \
    --epochs 20 \
    --imgsz 640 \
    --batch 16 \
    --name finetune_$(date +%Y%m%d_%H%M%S) \
    > logs/finetune_$(date +%Y%m%d_%H%M%S).log 2>&1 &
```

Notes:
- `--weights` points at the pretrained checkpoint — *this is what makes it fine-tuning, not from-scratch*.
- 20 epochs is the default for fine-tuning. More is usually overfitting, not improvement.
- `--name` is timestamped so we never clobber a previous run.

## After training finishes

1. **Find the best checkpoint**: `training/runs/<name>/weights/best.pt` (best validation mAP, not last epoch).
2. **Evaluate on the held-out test set**:
   ```bash
   python eval/compare.py \
       --baseline training/checkpoints/pretrained.pt \
       --candidate training/runs/<name>/weights/best.pt \
       --data data/smoking_litter.yaml
   ```
   This must produce a side-by-side table: precision, recall, mAP50, mAP50-95 per class.
3. **Decide**:
   - Candidate beats baseline on both smoking AND littering → promote.
   - Candidate beats baseline on one and is roughly equal on the other → cautious promote, sanity-check on real webcam footage first.
   - Anything else → keep baseline. Do not promote.

## Promoting a fine-tuned model to the demo
1. Export to ONNX:
   ```bash
   python training/export_onnx.py --weights training/runs/<name>/weights/best.pt \
       --output public/models/finetuned.onnx
   ```
2. Test locally first by setting `NEXT_PUBLIC_ACTIVE_MODEL=finetuned` in `.env.local` and running `npm run dev`. Open the demo page. Confirm detections look sane on real webcam input — your face, your room, your lighting.
3. Only after local confirmation: set the same env var in Vercel and redeploy.
4. Keep `pretrained.onnx` in `public/models/`. Switching back is a one-line env change.

## What to log every run
Append a row to `training/runs/log.md` with: date, base weights, dataset version, epochs, final metrics, decision (promoted / rejected), one-sentence reason. This is how we learn over time which changes help.

## Common failure modes
- **Overfitting after ~15 epochs** on small datasets → reduce epochs, or add augmentations.
- **One class regresses** while the other improves → dataset is imbalanced, or labels for the regressing class are noisier than you thought.
- **ONNX export silently changes outputs** → always run a single test image through both `.pt` and `.onnx` after export and compare predictions.
