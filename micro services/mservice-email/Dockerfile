FROM node:22-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci || npm install

COPY . .
RUN npm run build

EXPOSE 3222

CMD ["npm", "run", "start"]
