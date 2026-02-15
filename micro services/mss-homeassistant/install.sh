
# Build and run the Home Assistant micro-service Docker image

# 1) Install deps and build locally
npm ci
npm run build

# 2) Stop/remove running container
docker rm -f ms-hass

# 3) Build image from the local dist output
docker build -t ms-hass:latest .

# 4) Run container again
docker run -d \
  --name ms-hass \
  --restart unless-stopped \
  --env-file .env \
  -p 3223:3223 \
  ms-hass:latest
