FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY renderer/package.json ./package.json
RUN npm install --omit=dev
COPY renderer/server.js ./server.js
EXPOSE 8080
CMD ["node", "server.js"]
