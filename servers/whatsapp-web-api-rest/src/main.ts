import * as path from 'node:path';
import * as fs from 'node:fs';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '@src/app.module';

(async () => {
  const logger = new Logger('Bootstrap');
  const port = process.env.APP_PORT || 8085;
  const origin = ["'self'"];
  const packageJsonPath = path.join(process.cwd(), 'package.json');
  const packageVersion = fs.existsSync(packageJsonPath) ? JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))?.version : 'unknown';
  const imageTag = process.env.IMAGE_TAG || process.env.APP_IMAGE_TAG || 'not-set';
  const buildSha = process.env.GIT_SHA || process.env.BUILD_SHA || 'not-set';
  const apiAuthBearerToken = (process.env.API_AUTH_BEARER_TOKEN || '').trim();

  // Fastify app
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      bodyLimit: 26214400 /*25MB*/,
      forceCloseConnections: true,
    }),
  );

  // Public assets
  app.useStaticAssets({
    root: path.join(__dirname, '..', 'public'),
    prefix: '/public/',
  });

  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook('onRequest', (request: any, reply: any, done: () => void) => {
    if (apiAuthBearerToken === '') return done();

    const method = String(request?.method || '').toUpperCase();
    if (method === 'OPTIONS') return done();

    const url = String(request?.url || '');
    if (url === '/' || url.startsWith('/public/')) return done();

    const authorization = request?.headers?.authorization;
    const header = Array.isArray(authorization) ? String(authorization[0] || '') : String(authorization || '');
    const expected = `Bearer ${apiAuthBearerToken}`;

    if (header !== expected) {
      reply.code(401).send({ statusCode: 401, error: 'Unauthorized', message: 'Invalid or missing bearer token' });
      return;
    }

    done();
  });

  app.enableShutdownHooks();

  // Cors
  app.enableCors({
    origin: origin,
    credentials: true,
    methods: ['GET', 'POST', 'DELETE'],
  });

  logger.log(`Booting whatsapp-web-api-rest version=${packageVersion} imageTag=${imageTag} sha=${buildSha} pid=${process.pid} node=${process.version}`);
  if (apiAuthBearerToken === '') {
    logger.warn('API auth disabled: API_AUTH_BEARER_TOKEN is not set');
  }

  // Ready
  await app.listen(port, '0.0.0.0', () => {
    console.log(`\n🚀 Ready on port ${port}`);
  });
})();
