# Render deployment image for the Aegis FastAPI backend (app/api.py).
# Includes ffmpeg + OpenCV system libs, which the video/audio pipeline needs.
FROM python:3.11-slim

# System deps: ffmpeg (clip download/grab) + libs OpenCV needs at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libgl1 \
    libglib2.0-0 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps first so Docker can cache this layer.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the project (the .dockerignore keeps it lean).
COPY . .

# cameras.json holds local camera credentials and is gitignored, so it isn't in
# the repo. The cloud has no LAN cameras anyway — seed it from the example so
# serve.py can read the pipeline config (thresholds, audio settings).
RUN cp -n cameras.example.json cameras.json || true

# Render injects $PORT; serve.py runs init_db + loads cameras.json, then uvicorn.
CMD ["sh", "-c", "python serve.py --port ${PORT:-8080}"]
