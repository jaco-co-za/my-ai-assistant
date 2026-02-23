import type { Application, Request, Response, NextFunction } from 'express';
import { createLlmHandler } from './llm.js';

type DbGet = (sql: string, ...params: unknown[]) => Promise<any>;
type DbRun = (sql: string, ...params: unknown[]) => Promise<void>;
type DbAll = (sql: string, ...params: unknown[]) => Promise<any[]>;

type EndpointsConfig = {
  app: Application;
  dbGet: DbGet;
  dbRun: DbRun;
  dbAll: DbAll;
  syncMail?: () => Promise<void>;
  sendMail?: (payload: { to: string; subject: string; body: string }) => Promise<{
    messageId?: string;
    accepted?: string[];
    rejected?: string[];
    response?: string;
  }>;
  deleteMail?: (payload: { ids: number[] }) => Promise<{
    requested: number;
    found: number;
    deleted: number;
    skipped: number;
    errors?: string[];
  }>;
  moveMail?: (payload: { ids: number[]; folder: string }) => Promise<{
    requested: number;
    found: number;
    moved: number;
    skipped: number;
    target_folder: string;
    errors?: string[];
  }>;
  markAsRead?: (payload: { all?: boolean; ids?: number[]; folder?: string; limit?: number }) => Promise<{
    requested: number;
    found: number;
    marked: number;
    skipped: number;
    errors?: string[];
  }>;
  deleteTrash?: () => Promise<{
    deleted: number;
    skipped: number;
    found: number;
    errors?: string[];
  }>;
  deleteFolder?: (payload: { name: string }) => Promise<{
    deleted: number;
    skipped: number;
    found: number;
    errors?: string[];
  }>;
  skipAuth: boolean;
  authToken: string;
};

function normalizeSort(sort: unknown) {
  if (!sort) return null;
  if (typeof sort === 'string') {
    const [fieldRaw, directionRaw] = sort.split(':');
    return {
      field: fieldRaw,
      direction: (directionRaw || '').toLowerCase(),
    };
  }
  if (typeof sort === 'object' && sort && 'field' in sort) {
    const candidate = sort as { field?: unknown; direction?: unknown };
    return {
      field: String(candidate.field || ''),
      direction: String(candidate.direction || '').toLowerCase(),
    };
  }
  return null;
}

function buildSortClause(sort: { field?: string; direction?: string } | null, allowedFields: string[]) {
  if (!sort) return '';
  const field = String(sort.field || '');
  if (!allowedFields.includes(field)) return '';
  const direction = sort.direction === 'desc' ? 'DESC' : 'ASC';
  return ` ORDER BY ${field} ${direction}`;
}

function buildLimitClause(limit: unknown) {
  const num = Number(limit);
  if (!Number.isFinite(num) || num <= 0) return '';
  return ` LIMIT ${Math.floor(num)}`;
}

function createAuthMiddleware(skipAuth: boolean, authToken: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (skipAuth) {
      return next();
    }
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    if (!authToken || token !== authToken) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return next();
  };
}

function truncateWhatsappMessage(value: unknown, limit: number = 4400): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  if (value.length <= limit) {
    return value;
  }
  const suffix = '\n\n[truncated]';
  const maxBody = Math.max(0, limit - suffix.length);
  return `${value.slice(0, maxBody)}${suffix}`;
}

function parseBooleanLike(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value === 1;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
  }
  return false;
}

function hasNotifyIntent(prompt: unknown): boolean {
  if (typeof prompt !== 'string') {
    return false;
  }
  const text = prompt.toLowerCase();
  return (
    /\bnotify\b/.test(text) ||
    /\bnotification\b/.test(text) ||
    /\balert\s+me\b/.test(text) ||
    /\bping\s+me\b/.test(text) ||
    /\bremind\s+me\b/.test(text)
  );
}

function shouldNotifyFromPayload(body: unknown, result: unknown): boolean {
  const reqBody = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const llmResult = result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
  const explicitNotify =
    parseBooleanLike(reqBody.notify) ||
    parseBooleanLike(reqBody.notification) ||
    parseBooleanLike(reqBody.send_notification) ||
    parseBooleanLike(reqBody.sendNotification) ||
    parseBooleanLike(llmResult.notify);
  if (explicitNotify) {
    return true;
  }
  return hasNotifyIntent(reqBody.prompt);
}

export function registerEndpoints({
  app,
  dbGet,
  dbRun,
  dbAll,
  syncMail,
  sendMail,
  deleteMail,
  moveMail,
  markAsRead,
  deleteTrash,
  deleteFolder,
  skipAuth,
  authToken,
}: EndpointsConfig) {
  const sseClients = new Set<Response>();
  const authMiddleware = createAuthMiddleware(skipAuth, authToken);
  const llmHandler = createLlmHandler({
    dbAll,
    dbGet,
    dbRun,
    syncMail,
    sendMail,
    deleteMail,
    moveMail,
    markAsRead,
    deleteTrash,
    deleteFolder,
  });

  function broadcastEvent(payload: unknown) {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of sseClients) {
      res.write(data);
    }
  }

  app.get('/health', authMiddleware, async (req: Request, res: Response) => {
    const result = await dbGet('SELECT status, created_at FROM system_health ORDER BY id DESC LIMIT 1;');
    res.json({
      status: result?.status || 'ok',
      last_recorded_at: result?.created_at || null,
    });
  });

  app.post('/health', authMiddleware, async (req: Request, res: Response) => {
    const status = typeof req.body?.status === 'string' ? req.body.status : 'ok';
    await dbRun('INSERT INTO system_health (status) VALUES (?);', status);
    res.status(201).json({ status });
  });

  app.get('/events', authMiddleware, (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    res.write('data: {\"status\":\"connected\"}\\n\\n');
    sseClients.add(res);
    req.on('close', () => {
      sseClients.delete(res);
    });
  });

  app.post('/get-mail', authMiddleware, async (req: Request, res: Response) => {
    try {
      const { id, subject, body, attachment, from, limit, sort } = req.body || {};

      if (id === undefined && !subject && !body && !attachment && !from) {
        return res.status(200).json({
          success: false,
          response: 'At least one of id, subject, body, attachment, or from is required.',
        });
      }

      const normalizedSort = normalizeSort(sort);
      const limitClause = buildLimitClause(limit);

      if (id !== undefined && id !== null && id !== '') {
        const idValue = String(id);
        const rows = await dbAll(
          `SELECT * FROM email_messages WHERE id = ? OR server_uid = ?${buildSortClause(
            normalizedSort,
            ['id', 'server_uid', 'subject', 'received_at', 'from_raw'],
          )}${limitClause};`,
          idValue,
          idValue,
        );
        return res.json({ success: true, messages: rows || [] });
      }

      if (subject) {
        const subjectValue = String(subject).toLowerCase();
        const rows = await dbAll(
          `SELECT * FROM email_messages WHERE LOWER(subject) LIKE ?${buildSortClause(
            normalizedSort,
            ['id', 'server_uid', 'subject', 'received_at', 'from_raw'],
          )}${limitClause};`,
          `%${subjectValue}%`,
        );
        return res.json({ success: true, messages: rows || [] });
      }

      if (body) {
        const bodyValue = String(body).toLowerCase();
        const rows = await dbAll(
          `SELECT * FROM email_messages WHERE LOWER(text_body) LIKE ?${buildSortClause(
            normalizedSort,
            ['id', 'server_uid', 'subject', 'received_at', 'from_raw'],
          )}${limitClause};`,
          `%${bodyValue}%`,
        );
        return res.json({ success: true, messages: rows || [] });
      }

      if (from) {
        const fromValue = String(from).toLowerCase();
        const rows = await dbAll(
          `SELECT * FROM email_messages WHERE LOWER(from_raw) LIKE ?${buildSortClause(
            normalizedSort,
            ['id', 'server_uid', 'subject', 'received_at', 'from_raw'],
          )}${limitClause};`,
          `%${fromValue}%`,
        );
        return res.json({ success: true, messages: rows || [] });
      }

      if (attachment) {
        const attachmentValue = String(attachment).toLowerCase();
        const rows = await dbAll(
          `SELECT id, email_id, part, filename, disposition, content_type, size, storage_path
           FROM email_attachments
           WHERE LOWER(filename) LIKE ? OR LOWER(content_type) LIKE ? OR LOWER(disposition) LIKE ?${buildSortClause(
             normalizedSort,
             ['id', 'email_id', 'filename', 'content_type', 'size'],
           )}${limitClause};`,
          `%${attachmentValue}%`,
          `%${attachmentValue}%`,
          `%${attachmentValue}%`,
        );
        return res.json({ success: true, attachments: rows || [] });
      }

      return res.json({ success: true, messages: [] });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('GET-MAIL failed:', err);
      return res.status(500).json({ success: false, response: 'Internal server error' });
    }
  });

  app.post('/llm-query', authMiddleware, async (req: Request, res: Response) => {
    try {
      const result = await llmHandler(req.body);
      const sourceChannel =
        typeof req.body?.source_channel === 'string' ? String(req.body.source_channel).toLowerCase() : '';
      const message = sourceChannel === 'whatsapp'
        ? truncateWhatsappMessage((result as any)?.message, 4400)
        : undefined;
      const responsePayload = { confirm: false, ...result };
      if (shouldNotifyFromPayload(req.body, result)) {
        responsePayload.notify = true;
      }
      if (sourceChannel === 'whatsapp' && typeof message === 'string') {
        responsePayload.message = message;
      }
      return res.json(responsePayload);
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.error('LLM query failed:', err);
      const detail =
        typeof err?.message === 'string' && err.message.trim().length > 0
          ? err.message.trim()
          : 'Internal server error';
      return res.status(500).json({ success: false, confirm: false, message: detail });
    }
  });

  return { broadcastEvent };
}
