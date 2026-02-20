FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

ENV WHISPER_MODEL_SIZE=small
ENV WHISPER_DEVICE=cpu
ENV WHISPER_COMPUTE_TYPE=int8
ENV WHISPER_BEAM_SIZE=5
ENV WHISPER_VAD_FILTER=true

EXPOSE 3221

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "3221"]
