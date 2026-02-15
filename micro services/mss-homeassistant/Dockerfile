FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache sqlite

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY dist ./dist
COPY prompts ./prompts
COPY data ./data

EXPOSE 3223

CMD ["node", "dist/index.js"]
