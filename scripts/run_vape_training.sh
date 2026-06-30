#!/usr/bin/env bash
# Fine-tune 3-class smoking model (cigarette + vape) and export to public/models/pretrained.onnx
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f .env ]] || ! grep -q "ROBOFLOW_API_KEY=." .env 2>/dev/null; then
  echo "Missing .env with ROBOFLOW_API_KEY."
  echo "Create .env in the repo root:"
  echo "  ROBOFLOW_API_KEY=your_key_here"
  echo "Get a free key: https://app.roboflow.com/settings/api"
  exit 1
fi

mkdir -p logs
LOG="logs/vape_training_$(date +%Y%m%d_%H%M%S).log"
echo "Logging to $LOG"

source venv/bin/activate
RESUME_ARGS=()
if [[ -f models/runs/smoking_types/weights/last.pt ]]; then
  RESUME_ARGS=(--resume)
  echo "Resuming from models/runs/smoking_types/weights/last.pt"
fi

caffeinate -i python scripts/train_smoking_types.py --epochs 40 --force-promote --device cpu "${RESUME_ARGS[@]}" 2>&1 | tee "$LOG"
