"""Verify CUDA is visible to PyTorch / Ultralytics before serving.

Run in the Lightning T4 Studio:  python verify_gpu.py
Exits non-zero if CUDA is not available so it can gate a startup script.
"""

import sys

import torch

print("torch version      :", torch.__version__)
print("CUDA available     :", torch.cuda.is_available())
print("CUDA runtime (torch):", torch.version.cuda)

if torch.cuda.is_available():
    print("device count       :", torch.cuda.device_count())
    print("device name        :", torch.cuda.get_device_name(0))
    props = torch.cuda.get_device_properties(0)
    print("total VRAM (GB)    :", round(props.total_memory / 1024**3, 2))
else:
    print("\n[FAIL] CUDA is NOT visible to PyTorch. The GPU will not be used.")
    sys.exit(1)

# Ultralytics' own device check (mirrors what YOLO(...).to('cuda') will use).
try:
    from ultralytics.utils.checks import cuda_is_available

    print("ultralytics CUDA   :", cuda_is_available())
except Exception as exc:  # pragma: no cover - informational only
    print("ultralytics check skipped:", exc)

print("\n[OK] CUDA is available — the T4 will be utilized.")
