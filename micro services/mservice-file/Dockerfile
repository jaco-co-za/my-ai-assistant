FROM node:22.17.0-alpine3.22
WORKDIR /app

COPY package.json yarn.lock* package-lock.json* pnpm-lock.yaml* ./
RUN npm install

COPY . .
RUN npm run build

EXPOSE 3224
CMD ["npm", "run", "start"]