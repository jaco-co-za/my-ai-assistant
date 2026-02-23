import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import sqlite3 from 'sqlite3';
import { promisify } from 'node:util';
import PDFParser from 'pdf2json';
import { readAttachmentFile } from './attachmentStorage.js';

type DbAll = (sql: string, ...params: unknown[]) => Promise<any[]>;
type DbGet = (sql: string, ...params: unknown[]) => Promise<any>;
type DbRun = (sql: string, ...params: unknown[]) => Promise<void>;

type PromptTemplate = {
  name: string;
  version: number;
  instructions: string[];
  output_schema: Record<string, unknown>;
};

type LearningsSqlResult = {
  action: 'list' | 'delete' | 'none';
  sql: string;
};

type LearningExtract = {
  should_learn: boolean;
  learning?: string;
};

type EmailSqlResult = {
  sql: string;
  delivery?: 'attach' | 'read' | 'none';
  follow_up_question?: boolean;
  follow_up_message?: string;
};

type ReplyExtractResult = {
  mode: 'by_id' | 'search' | 'unknown';
  email_id?: number;
  search_query?: string;
  subject?: string;
  body?: string;
};

type ReplyBodyDeriveResult = {
  body: string;
};

type EmailReadSummaryResult = {
  email_id: string;
  from: string;
  to: string;
  cc: string[];
  bcc: string[];
  subject: string;
  received_at: string;
  folder: string;
  subfolder: string;
  body_text: string;
  body_html: string;
  ai_summary: string;
  attachments: Array<{
    id: string;
    name: string;
    mime_type: string;
    size_bytes: number;
  }>;
};

type AttachmentExplainResult = {
  message: string;
};

type UiAction = {
  type: 'prefill';
  label: string;
  text: string;
};

type LlmPayload = {
  prompt: string;
  result?: string;
  source_channel?: string;
  source_from?: string;
  skip_cache?: boolean;
  previous_sql?: string;
  error?: string;
  follow_up_context?: Array<{
    user_prompt: string;
    llm_reply: string;
    created_at: string | null;
  }>;
};

type LlmResponse = {
  success: boolean;
  type?: 'attachment' | 'message';
  message?: string;
  notify?: boolean;
  sql?: string;
  rows?: any[];
  email?: {
    id: number;
    from_raw: string | null;
    to_raw?: string | null;
    subject: string | null;
    received_at: string | null;
    body: string;
  };
  email_id?: number;
  from?: string;
  to?: string;
  subject?: string;
  received_at?: string;
  folder?: string;
  subfolder?: string;
  body_text?: string;
  body_html?: string;
  ai_summary?: string;
  summary?: string;
  summary_available?: boolean;
  attachment_details?: Array<{
    id: number;
    filename: string | null;
    content_type: string | null;
  }>;
  pdf_sections?: Array<{
    attachment_id: number;
    filename: string | null;
    extracted_text: string;
  }>;
  email_viewer_rows?: Array<{
    id: number;
    from_raw: string;
    to_raw: string;
    subject: string;
    received_at: string;
    folder: string;
    subfolder: string;
    body_text: string;
    body_html: string;
    attachments: string;
    attachment_ids: string;
    ai_summary: string;
    summary: string;
    summary_available: boolean;
  }>;
  attachments?: Array<{
    attachment_id: number;
    email_id: number;
    filename: string | null;
    content_type: string | null;
    folder_path: string | null;
    data_base64: string;
  }>;
  ui_actions?: UiAction[];
  confirm?: boolean;
  'follow-up-question'?: boolean;
  follow_up_question?: boolean;
};

type FolderCount = {
  path: string;
  name: string;
  count: number;
};

type SendMailPayload = {
  to: string;
  subject: string;
  body: string;
};

type SendMailResult = {
  messageId?: string;
  accepted?: string[];
  rejected?: string[];
  response?: string;
};

type DeleteMailResult = {
  requested: number;
  found: number;
  deleted: number;
  skipped: number;
  errors?: string[];
};

type MoveMailResult = {
  requested: number;
  found: number;
  moved: number;
  skipped: number;
  target_folder: string;
  errors?: string[];
};

type MarkReadResult = {
  requested: number;
  found: number;
  marked: number;
  skipped: number;
  errors?: string[];
};

type DeleteTrashResult = {
  deleted: number;
  skipped: number;
  found: number;
  errors?: string[];
};

type DeleteFolderResult = {
  deleted: number;
  skipped: number;
  found: number;
  errors?: string[];
};

type BlockSenderMatch = {
  pattern: string;
  matches: string[];
};

type AttachmentCandidate = {
  attachment_id: number;
  email_id: number;
  filename: string | null;
  content_type: string | null;
  storage_path: string | null;
  part: string | null;
  folder_name: string | null;
  folder_path: string | null;
  subject: string | null;
  from_raw: string | null;
  received_at: string | null;
};

type FollowUpTurn = {
  user_prompt: string;
  llm_reply: string;
  created_at: string | null;
};

const FOLLOW_UP_SESSION_KEY = 'default';
const FOLLOW_UP_MAX_TURNS = 8;
const WHATSAPP_INTENT_PHONE = '27714908172';
const EMAIL_DISABLE_FOLLOW_UP_QUESTIONS = parseBooleanLike(
  process.env.EMAIL_DISABLE_FOLLOW_UP_QUESTIONS ?? 'true',
);
const MAIL_SYNC_LLM_TIMEOUT_MS = Number.parseInt(process.env.MAIL_SYNC_LLM_TIMEOUT_MS || '8000', 10);
const ASSISTANT_TIMEOUT_MS = Number.parseInt(process.env.ASSISTANT_TIMEOUT_MS || '300000', 10);
const MAX_UI_ACTIONS = 12;

function isWhatsappChannel(sourceChannel?: string): boolean {
  return String(sourceChannel || '').trim().toLowerCase() === 'whatsapp';
}

function buildWhatsAppReadEmailLink(id: number | string): string {
  const normalized = String(id).trim();
  const text = encodeURIComponent(`read email ${normalized}`);
  return `https://api.whatsapp.com/send?phone=${WHATSAPP_INTENT_PHONE}&text=${text}`;
}

function buildReadEmailLink(id: number | string, sourceChannel?: string): string {
  if (isWhatsappChannel(sourceChannel)) {
    return buildWhatsAppReadEmailLink(id);
  }
  return '#';
}

function buildShowAttachmentsLink(id: number | string, sourceChannel?: string): string {
  if (isWhatsappChannel(sourceChannel)) {
    const normalized = String(id).trim();
    const text = encodeURIComponent(`show attachments for id ${normalized}`);
    return `https://api.whatsapp.com/send?phone=${WHATSAPP_INTENT_PHONE}&text=${text}`;
  }
  return '#';
}

function buildDownloadAttachmentLink(attachmentId: number | string, sourceChannel?: string): string {
  if (isWhatsappChannel(sourceChannel)) {
    const normalized = String(attachmentId).trim();
    const text = encodeURIComponent(`download attachment ${normalized}`);
    return `https://api.whatsapp.com/send?phone=${WHATSAPP_INTENT_PHONE}&text=${text}`;
  }
  return '#';
}

function formatEmailIdLabel(id: number | string, sourceChannel?: string): string {
  const value = String(id);
  if (isWhatsappChannel(sourceChannel)) {
    return `Email ID: ${value}`;
  }
  return `ID: ${value}`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeEmailHtml(rawHtml: string): string {
  let safe = String(rawHtml || '');
  safe = safe.replace(/<\s*(script|style|iframe|object|embed|link|meta|base)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
  safe = safe.replace(/\son\w+\s*=\s*(['"]).*?\1/gi, '');
  safe = safe.replace(/\son\w+\s*=\s*[^\s>]+/gi, '');
  safe = safe.replace(/\s(href|src)\s*=\s*(['"])\s*javascript:[\s\S]*?\2/gi, ' $1="#"');
  return safe.trim();
}

function renderEmailBodyAsHtml(body: string): string {
  const raw = String(body || '').trim();
  if (!raw) {
    return '<p>(no body)</p>';
  }
  const looksLikeHtml = /<\/?[a-z][\s\S]*>/i.test(raw);
  if (looksLikeHtml) {
    const safe = sanitizeEmailHtml(raw);
    return safe || '<p>(no body)</p>';
  }
  return `<p>${escapeHtml(raw).replace(/\r?\n/g, '<br>')}</p>`;
}

function makePrefillAction(label: string, text: string): UiAction {
  return { type: 'prefill', label, text };
}

function escapeInlineActionValue(value: string): string {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function renderInlinePrefillAction(label: string, text: string): string {
  return `[action:prefill label="${escapeInlineActionValue(label)}" text="${escapeInlineActionValue(text)}"]`;
}

function renderInlineActions(actions?: UiAction[]): string[] {
  if (!Array.isArray(actions) || actions.length === 0) {
    return [];
  }
  const lines: string[] = [];
  for (const action of actions) {
    if (action?.type !== 'prefill') {
      continue;
    }
    const label = String(action.label || '').trim();
    const text = String(action.text || '').trim();
    if (!label || !text) {
      continue;
    }
    lines.push(renderInlinePrefillAction(label, text));
  }
  return lines;
}

function extractReadInlineAction(actions?: UiAction[]): { readInlineAction?: string; otherInlineActions: string[] } {
  const lines = renderInlineActions(actions);
  const readInlineAction = lines.find((line) => /text="read email\s+\d+"/i.test(line));
  const otherInlineActions = lines.filter((line) => line !== readInlineAction);
  return { readInlineAction, otherInlineActions };
}

function pushUiAction(target: UiAction[], action: UiAction, maxActions: number = MAX_UI_ACTIONS): void {
  if (target.length >= maxActions) {
    return;
  }
  const key = `${action.type}|${action.text.trim().toLowerCase()}`;
  const exists = target.some((entry) => `${entry.type}|${entry.text.trim().toLowerCase()}` === key);
  if (!exists) {
    target.push(action);
  }
}

function toErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim().length > 0) {
      return message;
    }
  }
  return 'Unknown error';
}

async function runWithSoftTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<
  | { status: 'completed'; value: T }
  | { status: 'failed'; error: string }
  | { status: 'timed_out' }
> {
  const duration = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : 8000;
  const operationPromise = operation()
    .then((value) => ({ status: 'completed' as const, value }))
    .catch((err) => ({ status: 'failed' as const, error: toErrorMessage(err) }));
  const timeoutPromise = new Promise<{ status: 'timed_out' }>((resolve) => {
    setTimeout(() => resolve({ status: 'timed_out' }), duration);
  });
  const first = await Promise.race([operationPromise, timeoutPromise]);
  if (first.status === 'timed_out') {
    operationPromise.then((later) => {
      if (later.status === 'failed') {
        // eslint-disable-next-line no-console
        console.warn(`[mail-sync] background sync failed after timeout: ${later.error}`);
      }
    });
  }
  return first;
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

function extractSkipConfirmation(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') {
    return false;
  }
  const candidate = payload as Record<string, unknown>;
  const raw =
    candidate.skip_confirmation ??
    candidate.skipConfirmation ??
    candidate.skip_confirm ??
    candidate.skipConfirm;
  if (typeof raw === 'boolean') {
    return raw;
  }
  if (typeof raw === 'string') {
    return raw.toLowerCase() === 'true' || raw === '1' || raw.toLowerCase() === 'yes';
  }
  return false;
}

function extractFollowUpHint(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') {
    return false;
  }
  const candidate = payload as Record<string, unknown>;
  const raw =
    candidate.follow_up_question ??
    candidate.followUpQuestion ??
    candidate.follow_up ??
    candidate.followUp;
  if (typeof raw === 'boolean') {
    return raw;
  }
  if (typeof raw === 'string') {
    return raw.toLowerCase() === 'true' || raw === '1' || raw.toLowerCase() === 'yes';
  }
  return false;
}

const promptCache = new Map<string, PromptTemplate>();
const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PDF_DEFAULT_PASSWORD = process.env.PDF_DEFAULT_PASSWORD || '';
let learningsDb: sqlite3.Database | null = null;
let learningsDbGet: (sql: string, ...params: unknown[]) => Promise<any>;
let learningsDbRun: (sql: string, ...params: unknown[]) => Promise<void>;
let learningsDbAll: (sql: string, ...params: unknown[]) => Promise<any[]>;
let cachedLearnings: string[] = [];

const STOP_WORDS = new Set([
  'the',
  'is',
  'always',
  'be',
  'are',
  'a',
  'an',
  'and',
  'or',
  'of',
  'to',
  'in',
  'on',
  'for',
  'with',
  'at',
  'by',
  'from',
  'as',
  'that',
  'this',
  'it',
  'its',
  'your',
  'my',
  'our',
  'their',
  'was',
  'were',
  'will',
  'would',
  'should',
  'could',
  'can',
  'may',
  'might',
  'do',
  'does',
  'did',
  'have',
  'has',
  'had',
  'about',
  'into',
  'over',
  'under',
  'up',
  'down',
  'out',
  'off',
  'if',
  'then',
  'so',
  'than',
  'too',
  'very',
]);

function loadPrompt(name: string): PromptTemplate {
  const cached = promptCache.get(name);
  if (cached) {
    return cached;
  }
  const promptPath = path.resolve(CURRENT_DIR, '..', 'prompts', `${name}.json`);
  const raw = fs.readFileSync(promptPath, 'utf-8');
  const parsed = JSON.parse(raw) as PromptTemplate;
  promptCache.set(name, parsed);
  return parsed;
}

function renderPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : '';
  });
}

function tokenizeText(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && !STOP_WORDS.has(token));
}

function learningTokensMatchPrompt(learning: string, promptText: string): boolean {
  const tokens = tokenizeText(learning);
  if (tokens.length === 0) {
    return false;
  }
  return tokens.some((token) => promptText.includes(token));
}

function buildPromptMessage(
  template: PromptTemplate,
  vars: Record<string, string>,
  learnings: string[],
) {
  const base = template.instructions.join('\n');
  const rendered = renderPrompt(base, vars);
  if (!learnings || learnings.length === 0) {
    return rendered;
  }
  const promptText = `${vars.payload ?? ''}`.toLowerCase();
  const filteredLearnings = learnings.filter((learning) =>
    learningTokensMatchPrompt(learning, promptText),
  );
  if (filteredLearnings.length === 0) {
    return rendered;
  }
  const contextLines = ['Additional context:', ...filteredLearnings.map((learning) => `- ${learning}`)];
  return `${contextLines.join('\n')}\n\n${rendered}`;
}

function parseVerb(result?: string): string | null {
  if (!result) return null;
  const parts = Object.fromEntries(
    result.split('|').map((part) => {
      const [key, value] = part.split(':').map((segment) => segment.trim());
      return [key.toLowerCase(), value];
    }),
  );
  const verb = parts.verb;
  return typeof verb === 'string' ? verb.toLowerCase() : null;
}

function parseIntent(result?: string): string | null {
  if (!result) return null;
  const parts = Object.fromEntries(
    result.split('|').map((part) => {
      const [key, value] = part.split(':').map((segment) => segment.trim());
      return [key.toLowerCase(), value];
    }),
  );
  const intent = parts.intent;
  return typeof intent === 'string' ? intent.toLowerCase() : null;
}

function isLearningIntent(verb: string | null, intent: string | null, prompt: string): boolean {
  const verbValue = verb?.toLowerCase() ?? '';
  const intentValue = intent?.toLowerCase() ?? '';
  if (['teach', 'learn', 'define'].includes(verbValue)) {
    return true;
  }
  if (
    intentValue.includes('learn') ||
    intentValue.includes('teach') ||
    intentValue.includes('define')
  ) {
    return true;
  }
  const text = prompt.toLowerCase();
  return text.includes('learn') || text.includes('remember') || text.includes('teach');
}

function isMailSyncRequest(prompt: string): boolean {
  const text = prompt.toLowerCase();
  const hasAction = /\b(refresh|reload|sync|resync|check|update|pull)\b/.test(text);
  const hasMail = /\b(mail|email|emails|inbox|mailbox|mailboxes|mailboxed)\b/.test(text);
  return hasAction && hasMail;
}

function isSendMailRequest(prompt: string): boolean {
  const text = prompt.toLowerCase();
  if (/\b(reply|respond)\b/.test(text)) {
    return false;
  }
  const hasSend = /\bsend\b/.test(text);
  const hasMail = /\b(mail|email|emails)\b/.test(text);
  return hasSend && hasMail;
}

function isReplyMailRequest(prompt: string): boolean {
  const text = prompt.toLowerCase();
  const hasReply = /\b(reply|respond)\b/.test(text);
  const hasMailRef = /\b(mail|email|message)\b/.test(text);
  return hasReply && hasMailRef;
}

function isDeleteMailRequest(prompt: string): boolean {
  const text = prompt.toLowerCase();
  if (/\bblocklist|blocked\b/.test(text)) {
    return false;
  }
  const hasDelete = /\b(delete|remove|purge)\b/.test(text);
  const hasMail = /\b(mail|email|emails)\b/.test(text);
  return hasDelete && hasMail;
}

function isMoveMailRequest(prompt: string): boolean {
  const text = prompt.toLowerCase();
  const hasMove = /\b(move)\b/.test(text);
  const hasMail = /\b(mail|email|emails|message)\b/.test(text);
  const hasTarget = /\bto\s+[a-z0-9_.-]+\b/.test(text);
  return hasMove && hasMail && hasTarget;
}

function extractMoveFolder(prompt: string): string | null {
  const explicit = prompt.match(/\bto\s+([a-z0-9_.-]+)\b/i);
  if (!explicit?.[1]) {
    return null;
  }
  return String(explicit[1]).trim();
}

function isMarkReadRequest(prompt: string): boolean {
  const text = prompt.toLowerCase();
  const hasMark = /\b(mark|set)\b/.test(text);
  const hasRead = /\b(read|seen)\b/.test(text);
  const hasMail = /\b(mail|email|emails|mails|message|messages|inbox|mailbox)\b/.test(text);
  return hasMark && hasRead && hasMail;
}

function isEmptyTrashRequest(prompt: string): boolean {
  const text = prompt.toLowerCase();
  const hasAction = /\b(empty|clear|purge)\b/.test(text);
  const hasTrash = /\btrash\b/.test(text);
  return hasAction && hasTrash;
}

function isBlockSenderRequest(prompt: string): boolean {
  const text = prompt.toLowerCase();
  if (/\bblock\s+(?:email|mail|message)\s+\d+\b/.test(text)) {
    return false;
  }
  const hasBlock = /\bblock\b/.test(text);
  const hasSenderTarget =
    /\b(sender|senders)\b/.test(text) ||
    /\bblock\b\s+(?:emails?\s+)?from\b/.test(text);
  const hasEmailCountPhrase = /\bblock\s+emails?\b/.test(text) && !/\b\d+\b/.test(text);
  const hasSender = hasSenderTarget || hasEmailCountPhrase;
  return hasBlock && hasSender;
}

function isBlockEmailByIdRequest(prompt: string): boolean {
  const text = prompt.toLowerCase();
  return /\bblock\s+(?:email|mail|message)\s+\d+\b/.test(text);
}

function isUnblockSenderRequest(prompt: string): boolean {
  const text = prompt.toLowerCase();
  const hasUnblock = /\bunblock\b/.test(text);
  const hasSender = /\b(sender|senders|from|email)\b/.test(text);
  return hasUnblock && hasSender;
}

function isUnblockByIdRequest(prompt: string): boolean {
  const text = prompt.toLowerCase();
  const hasUnblock = /\bunblock|remove|delete\b/.test(text);
  const hasBlocklist = /\bblocklist|blocked\b/.test(text);
  const hasId = /\bid\b/.test(text) || /\b#\d+\b/.test(text) || /\b\d+\b/.test(text);
  return (hasUnblock && hasBlocklist && hasId) || (hasBlocklist && hasId);
}

function isClearBlocklistRequest(prompt: string): boolean {
  const text = prompt.toLowerCase();
  const hasAction = /\b(clear|empty|remove|delete)\b/.test(text);
  const hasBlocklist = /\bblocklist|blocked\b/.test(text);
  const hasAll = /\ball\b/.test(text);
  return hasAction && hasBlocklist && hasAll;
}

function isShowBlocklistRequest(prompt: string): boolean {
  const text = prompt.toLowerCase();
  const hasShow = /\b(show|list|view|display)\b/.test(text);
  const hasBlockContext = /\b(blocklist|blocked\s+senders?|blocked\s+emails?|block\s+list)\b/.test(
    text,
  );
  return hasShow && hasBlockContext;
}

function isShowAttachmentsForEmailRequest(prompt: string): boolean {
  const text = prompt.toLowerCase();
  const hasAttachment = /\battachments?\b/.test(text);
  const hasListAction = /\b(show|list|display|get)\b/.test(text);
  const emailId = extractEmailIdForAttachment(prompt);
  return hasAttachment && hasListAction && emailId !== null;
}

function isReadMailRequest(prompt: string): boolean {
  const text = prompt.toLowerCase();
  const hasExplicitReadVerb = /\b(read|open|summari[sz]e|summary)\b/.test(text);
  const hasShowWithReadCue = /\bshow\b/.test(text) && /\b(body|content|details?|full)\b/.test(text);
  const hasRead = hasExplicitReadVerb || hasShowWithReadCue;
  const hasMail = /\b(mail|email|message)\b/.test(text);
  const hasId = /\b\d+\b/.test(text);
  const hasRelativeRef = /\b(last|latest|most recent|newest|first|oldest|earliest)\b/.test(text);
  return hasRead && hasMail && (hasId || hasRelativeRef);
}

function isSummaryMailRequest(prompt: string): boolean {
  const text = prompt.toLowerCase();
  const hasSummary = /\b(summari[sz]e|summary)\b/.test(text);
  const hasMail = /\b(mail|email|message)\b/.test(text);
  return hasSummary && hasMail;
}

async function resolveReadMailTargetId(dbGet: DbGet, prompt: string): Promise<number | null> {
  const ids = parseDeleteIds(prompt);
  if (ids.length > 0) {
    return ids[0];
  }
  const lowered = prompt.toLowerCase();
  const asksOldest =
    /\b(oldest|earliest)\b/.test(lowered) ||
    (/\blast\b/.test(lowered) && /\bnot\s+(?:the\s+)?latest\b/.test(lowered));
  const asksLatest =
    /\b(latest|most recent|newest)\b/.test(lowered) ||
    /\bfirst\b/.test(lowered) ||
    /\blast\b/.test(lowered);
  if (!asksOldest && !asksLatest) {
    return null;
  }
  const order = asksOldest ? 'ASC' : 'DESC';
  const row = await dbGet(
    `SELECT id
     FROM email_messages
     WHERE received_at IS NOT NULL
     ORDER BY received_at ${order}, id ${order}
     LIMIT 1;`,
  );
  const id = Number(row?.id);
  return Number.isFinite(id) && id > 0 ? Math.floor(id) : null;
}

async function resolveRelativeDeleteIds(dbGet: DbGet, prompt: string): Promise<number[]> {
  const lowered = prompt.toLowerCase();
  const hasDelete = /\b(delete|remove|purge)\b/.test(lowered);
  const hasMail = /\b(mail|email|message)\b/.test(lowered);
  if (!hasDelete || !hasMail) {
    return [];
  }
  const asksOldest =
    /\b(oldest|earliest)\b/.test(lowered) ||
    (/\blast\b/.test(lowered) && /\bnot\s+(?:the\s+)?latest\b/.test(lowered));
  const asksLatest =
    /\b(last|latest|most recent|newest|first)\b/.test(lowered) && !asksOldest;
  if (!asksOldest && !asksLatest) {
    return [];
  }
  const order = asksOldest ? 'ASC' : 'DESC';
  const row = await dbGet(
    `SELECT id
     FROM email_messages
     WHERE received_at IS NOT NULL
     ORDER BY received_at ${order}, id ${order}
     LIMIT 1;`,
  );
  const id = Number(row?.id);
  if (!Number.isFinite(id) || id <= 0) {
    return [];
  }
  return [Math.floor(id)];
}

function isPluralAttachmentNamesRequest(prompt: string): boolean {
  const text = prompt.toLowerCase();
  const hasPluralAttachments = /\battachments\b/.test(text);
  if (!hasPluralAttachments) {
    return false;
  }
  const explicitBinaryRequest =
    /\b(base64|bytes?|binary|raw\s+file|actual\s+file)\b/.test(text) ||
    /\b(download|send)\b/.test(text);
  return !explicitBinaryRequest;
}

function shouldReturnBinaryAttachment(prompt: string): boolean {
  const text = prompt.toLowerCase();
  return /\b(download|fetch|display)\b/.test(text);
}

function isDirectAttachmentFetchByIdRequest(prompt: string): boolean {
  const hasAttachmentId = extractAttachmentIdForRequest(prompt) !== null;
  if (!hasAttachmentId) {
    return false;
  }
  return shouldReturnBinaryAttachment(prompt);
}

function isPdfMentioned(prompt: string): boolean {
  return /\bpdf\b/i.test(prompt);
}

function isNonPdfRequested(prompt: string): boolean {
  const text = prompt.toLowerCase();
  return /\b(non[-\s]?pdf|not\s+(?:a\s+)?pdf|without\s+pdf)\b/.test(text);
}

function isLastMailReference(prompt: string): boolean {
  const text = prompt.toLowerCase();
  const patternA = /\b(last|latest|most recent)\b[\w\s]{0,20}\b(mail|email)\b/;
  const patternB = /\b(mail|email)\b[\w\s]{0,20}\b(last|latest|most recent)\b/;
  return patternA.test(text) || patternB.test(text);
}

function isFirstMailReference(prompt: string): boolean {
  const text = prompt.toLowerCase();
  const patternA = /\b(first|oldest|earliest)\b[\w\s]{0,20}\b(mail|email)\b/;
  const patternB = /\b(mail|email)\b[\w\s]{0,20}\b(first|oldest|earliest)\b/;
  return patternA.test(text) || patternB.test(text);
}

function extractEmailCacheRemovalTarget(prompt: string): string | null {
  const match = prompt.match(/^remove\s+from\s+(?:my\s+)?email\s+cache\b[:\-\s]*/i);
  if (!match) {
    return null;
  }
  const rawTarget = prompt.trim().slice(match[0].length).trim();
  if (!rawTarget) {
    return '';
  }
  const cleaned = rawTarget.trim().replace(/[.,!?;:]+$/, '').trim();
  return stripWrappingQuotes(cleaned);
}

function extractEmailIdForAttachment(prompt: string): number | null {
  const directMatch = prompt.match(/\bemail(?:\s+id)?\s*[#: ]\s*(\d+)\b/i);
  if (directMatch) {
    const value = Number(directMatch[1]);
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  const mailRefMatch = prompt.match(/\b(?:mail|email)\s+(\d+)\b/i);
  if (mailRefMatch) {
    const value = Number(mailRefMatch[1]);
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  const fromMailMatch = prompt.match(/\bfrom\s+(?:mail|email)\s+(\d+)\b/i);
  if (fromMailMatch) {
    const value = Number(fromMailMatch[1]);
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  const fromIdMatch = prompt.match(/\bfrom\s+(\d+)\b/i);
  if (fromIdMatch) {
    const value = Number(fromIdMatch[1]);
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  const forMailMatch = prompt.match(/\bfor\s+(?:mail|email)?\s*(\d+)\b/i);
  if (forMailMatch) {
    const value = Number(forMailMatch[1]);
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (/\battachment(?:\s+id)?\s*[#: ]\s*\d+\b/i.test(prompt)) {
    return null;
  }
  const idMatch = prompt.match(/\bid\s*[#: ]\s*(\d+)\b/i);
  if (idMatch) {
    const value = Number(idMatch[1]);
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  return null;
}

function extractAttachmentIdForRequest(prompt: string): number | null {
  const directMatch = prompt.match(/\b(?:attachment|attachement|file)(?:\s+id)?\s*[#: ]\s*(\d+)\b/i);
  if (directMatch?.[1]) {
    const value = Number(directMatch[1]);
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  const verbMatch = prompt.match(
    /\b(?:display|download|fetch|get|open|show)\s+(?:the\s+)?(?:attachment|attachement|file)\s+(\d+)\b/i,
  );
  if (verbMatch?.[1]) {
    const value = Number(verbMatch[1]);
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  return null;
}

function extractAttachmentFilenameHint(prompt: string): string | null {
  const quoted = prompt.match(/["']([^"']+\.[a-z0-9]{2,8})["']/i);
  if (quoted?.[1]) {
    return quoted[1].trim();
  }
  const inline = prompt.match(/\b([a-z0-9][a-z0-9_. ()-]*\.[a-z0-9]{2,8})\b/i);
  if (inline?.[1]) {
    return inline[1].trim();
  }
  return null;
}

function extractFolderHint(prompt: string): string | null {
  const explicit = prompt.match(/\bin\s+([a-z0-9_.-]+)\s+folder\b/i);
  if (explicit?.[1]) {
    return explicit[1].trim().toLowerCase();
  }
  const inline = prompt
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .match(/\bmy\s+(?:mails?|emails?)\s+([a-z0-9_.-]+)\b/i);
  if (inline?.[1]) {
    const candidate = inline[1].trim().toLowerCase();
    const reserved = new Set([
      'from',
      'today',
      'yesterday',
      'this',
      'last',
      'week',
      'month',
      'year',
      'friday',
      'monday',
      'tuesday',
      'wednesday',
      'thursday',
      'saturday',
      'sunday',
      'all',
      'latest',
      'newest',
      'oldest',
      'recent',
      'for',
      'on',
      'in',
    ]);
    if (!reserved.has(candidate)) {
      return candidate;
    }
  }
  const known = ['inbox', 'sent', 'trash', 'junk', 'spam', 'archive', 'topay'];
  const lowered = prompt.toLowerCase();
  const matched = known.find((entry) => lowered.includes(entry));
  return matched ?? null;
}

function extractFolderToEmpty(prompt: string): string | null {
  const text = prompt.trim();
  const match = text.match(
    /\b(?:empty|clear|purge)\s+(?:the\s+)?(\"[^\"]+\"|'[^']+'|[a-z0-9_.-]+(?:\s+[a-z0-9_.-]+)*)/i,
  );
  if (!match) {
    return null;
  }
  let value = match[1].trim();
  value = stripWrappingQuotes(value);
  value = value.replace(/\b(folder|mailbox)\b/i, '').trim();
  if (!value) {
    return null;
  }
  const lowered = value.toLowerCase();
  if (lowered === 'inbox' || lowered === 'sent') {
    return lowered;
  }
  if (/\btrash\b/i.test(value)) {
    return null;
  }
  return value;
}

function extractBlockPatterns(prompt: string): string[] {
  const patterns: string[] = [];
  const direct = prompt.match(/\bblock\b\s+(?:sender|senders|from|email|emails)\s+(.+)/i);
  const fromMatch = prompt.match(/\bblock\b\s+emails?\s+from\s+(.+)/i);
  const raw = (fromMatch?.[1] ?? direct?.[1] ?? '').trim();
  if (!raw) {
    return patterns;
  }
  return raw
    .split(',')
    .map((part) => stripWrappingQuotes(part.trim()))
    .filter((part) => part.length > 0);
}

function extractUnblockPatterns(prompt: string): string[] {
  const match = prompt.match(/\bunblock\b\s+(?:sender|senders|from|email)\s+(.+)/i);
  const raw = match?.[1] ?? '';
  if (!raw) {
    return [];
  }
  return raw
    .split(',')
    .map((part) => stripWrappingQuotes(part.trim()))
    .filter((part) => part.length > 0);
}

function extractUnblockIds(prompt: string): number[] {
  const numbers = prompt.match(/\b\d+\b/g) || [];
  const ids = numbers
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  return Array.from(new Set(ids)).sort((a, b) => a - b);
}

function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function extractEmailAddress(value: string | null): string | null {
  if (!value) return null;
  const angled = value.match(/<([^<>@\s]+@[^<>@\s]+\.[^<>@\s]+)>/);
  if (angled && angled[1]) {
    return angled[1].trim();
  }
  const direct = value.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
  if (direct && direct[0]) {
    return direct[0].trim();
  }
  return null;
}

function extractSendMailFields(prompt: string): SendMailPayload | null {
  const pattern =
    /send\s+(?:an?\s+)?email\s+to\s+([^\s]+)\s+(?:with\s+)?subject\s+(.+?)\s+(?:and\s+)?body\s+([\s\S]+)/i;
  const match = prompt.match(pattern);
  if (!match) {
    return null;
  }
  const to = stripWrappingQuotes(match[1].trim());
  const subject = stripWrappingQuotes(match[2].trim());
  const body = stripWrappingQuotes(match[3].trim());
  if (!to || !subject || !body) {
    return null;
  }
  return { to, subject, body };
}

function extractStandaloneEmailId(prompt: string): number | null {
  const trimmed = prompt.trim();
  if (/^\d+$/.test(trimmed)) {
    const value = Number(trimmed);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
  }
  const match = trimmed.match(/\b(?:id|email|mail|message)?\s*[#: ]\s*(\d+)\b/i);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

function extractCandidateIdsFromFollowUpContext(context: FollowUpTurn[]): number[] {
  const ids: number[] = [];
  for (const turn of context) {
    const text = String(turn?.llm_reply || '');
    const matches = text.matchAll(/\bid=(\d+)\b/g);
    for (const match of matches) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > 0) {
        ids.push(Math.floor(value));
      }
    }
  }
  return Array.from(new Set(ids));
}

type ReplyMailRequest =
  | { mode: 'by_id'; id: number; subject?: string; body?: string }
  | { mode: 'search'; query: string; subject?: string; body?: string };

function parseReplySubjectBody(value: string): { subject?: string; body?: string } {
  const text = value.trim();
  if (!text) {
    return {};
  }
  const subjectThenBody = text.match(
    /\bsubject\s+(.+?)\s+(?:and\s+)?body\s+([\s\S]+)/i,
  );
  if (subjectThenBody) {
    const subject = stripWrappingQuotes((subjectThenBody[1] || '').trim());
    const body = stripWrappingQuotes((subjectThenBody[2] || '').trim());
    return {
      subject: subject || undefined,
      body: body || undefined,
    };
  }
  const bodyThenSubject = text.match(
    /\bbody\s+(.+?)\s+(?:and\s+)?subject\s+([\s\S]+)/i,
  );
  if (bodyThenSubject) {
    const body = stripWrappingQuotes((bodyThenSubject[1] || '').trim());
    const subject = stripWrappingQuotes((bodyThenSubject[2] || '').trim());
    return {
      subject: subject || undefined,
      body: body || undefined,
    };
  }

  const subjectOnly = text.match(/\bsubject\s+(.+)/i);
  const bodyOnly = text.match(/\bbody\s+(.+)/i);
  const withBody = text.match(/\bwith\s+([\s\S]+)/i);

  const subject = subjectOnly ? stripWrappingQuotes((subjectOnly[1] || '').trim()) : '';
  const body = bodyOnly
    ? stripWrappingQuotes((bodyOnly[1] || '').trim())
    : withBody
      ? stripWrappingQuotes((withBody[1] || '').trim())
      : '';

  return {
    subject: subject || undefined,
    body: body || undefined,
  };
}

function extractReplyMailRequest(prompt: string): ReplyMailRequest | null {
  const byIdPatterns = [
    /\b(?:reply|respond)\s+(?:to\s+)?(?:mail|email|message)\s+(\d+)\b([\s\S]*)/i,
    /\b(?:reply|respond)\s+(\d+)\b([\s\S]*)/i,
  ];
  for (const pattern of byIdPatterns) {
    const match = prompt.match(pattern);
    if (!match) continue;
    const id = Number(match[1]);
    if (!Number.isFinite(id) || id <= 0) {
      return null;
    }
    const tail = String(match[2] || '');
    const parsed = parseReplySubjectBody(tail);
    return {
      mode: 'by_id',
      id: Math.floor(id),
      subject: parsed.subject,
      body: parsed.body,
    };
  }

  const prefixMatch = prompt.match(/\b(?:reply|respond)\s+(?:to\s+)?(?:emails?|messages?)\s+([\s\S]+)/i);
  if (prefixMatch) {
    const tail = String(prefixMatch[1] || '').trim();
    if (!tail) {
      return null;
    }
    const marker = tail.search(/\b(?:with|subject|body)\b/i);
    const queryPart = marker >= 0 ? tail.slice(0, marker).trim() : tail;
    const contentPart = marker >= 0 ? tail.slice(marker).trim() : '';
    const query = stripWrappingQuotes(queryPart);
    const parsed = parseReplySubjectBody(contentPart);
    if (!query) {
      return null;
    }
    return {
      mode: 'search',
      query,
      subject: parsed.subject,
      body: parsed.body,
    };
  }
  return null;
}

async function loadReplyCandidates(
  dbAll: DbAll,
  query: string,
  limit: number = 5,
): Promise<Array<{ id: number; from_raw: string | null; subject: string | null; received_at: string | null }>> {
  const lowered = query.toLowerCase();
  const isOldestIntent = /\b(last|oldest)\b/.test(lowered);
  const fromPhraseMatch = lowered.match(/\bfrom\s+(.+)$/i);
  const fromPhrase = fromPhraseMatch ? fromPhraseMatch[1].trim() : '';
  const genericTokens = lowered
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .filter((token) => !new Set(['first', 'last', 'latest', 'oldest', 'mail', 'email', 'message', 'from', 'the']).has(token));
  const fromTokens = fromPhrase
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);

  function normalize(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function diceSimilarity(a: string, b: string): number {
    const left = normalize(a).replace(/\s+/g, '');
    const right = normalize(b).replace(/\s+/g, '');
    if (!left || !right) return 0;
    if (left === right) return 1;
    if (left.length < 2 || right.length < 2) return left === right ? 1 : 0;
    const pairs = (value: string) => {
      const result: string[] = [];
      for (let i = 0; i < value.length - 1; i += 1) {
        result.push(value.slice(i, i + 2));
      }
      return result;
    };
    const aPairs = pairs(left);
    const bPairs = pairs(right);
    const bCounts = new Map<string, number>();
    for (const pair of bPairs) {
      bCounts.set(pair, (bCounts.get(pair) || 0) + 1);
    }
    let overlap = 0;
    for (const pair of aPairs) {
      const count = bCounts.get(pair) || 0;
      if (count > 0) {
        overlap += 1;
        bCounts.set(pair, count - 1);
      }
    }
    return (2 * overlap) / (aPairs.length + bPairs.length);
  }

  const rows = await dbAll(
    `SELECT id, from_raw, subject, received_at, text_body
     FROM email_messages
     ORDER BY received_at DESC, id DESC
     LIMIT 500;`,
  );
  const scored = rows
    .map((row) => ({
      id: Number(row?.id),
      from_raw: row?.from_raw ? String(row.from_raw) : null,
      subject: row?.subject ? String(row.subject) : null,
      received_at: row?.received_at ? String(row.received_at) : null,
      text_body: row?.text_body ? String(row.text_body) : null,
    }))
    .filter((row) => Number.isFinite(row.id) && row.id > 0)
    .map((row) => {
      const fromText = row.from_raw || '';
      const subjectText = row.subject || '';
      const bodyText = row.text_body || '';
      const haystack = `${fromText} ${subjectText} ${bodyText}`.toLowerCase();

      let score = 0;
      for (const token of genericTokens) {
        if (haystack.includes(token)) {
          score += 0.7;
        }
      }
      if (fromTokens.length > 0) {
        for (const token of fromTokens) {
          if (fromText.toLowerCase().includes(token)) {
            score += 1.0;
          }
        }
        score += diceSimilarity(fromPhrase, fromText) * 2.5;
      } else {
        score += diceSimilarity(lowered, `${fromText} ${subjectText}`) * 1.2;
      }
      return { row, score };
    })
    .filter((entry) => entry.score > 0.35)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aTime = a.row.received_at ? Date.parse(a.row.received_at) : 0;
      const bTime = b.row.received_at ? Date.parse(b.row.received_at) : 0;
      return isOldestIntent ? aTime - bTime : bTime - aTime;
    })
    .slice(0, limit)
    .map((entry) => ({
      id: entry.row.id,
      from_raw: entry.row.from_raw,
      subject: entry.row.subject,
      received_at: entry.row.received_at,
    }));

  if (scored.length > 0) {
    return scored;
  }

  // Fallback to direct LIKE for very short/simple phrases.
  const fallback = await dbAll(
    `SELECT id, from_raw, subject, received_at
     FROM email_messages
     WHERE LOWER(COALESCE(from_raw, '')) LIKE ?
        OR LOWER(COALESCE(subject, '')) LIKE ?
        OR LOWER(COALESCE(text_body, '')) LIKE ?
     ORDER BY received_at DESC, id DESC
     LIMIT ?;`,
    `%${lowered}%`,
    `%${lowered}%`,
    `%${lowered}%`,
    limit,
  );
  return fallback
    .map((row) => ({
      id: Number(row?.id),
      from_raw: row?.from_raw ? String(row.from_raw) : null,
      subject: row?.subject ? String(row.subject) : null,
      received_at: row?.received_at ? String(row.received_at) : null,
    }))
    .filter((row) => Number.isFinite(row.id) && row.id > 0);
}

function parseDeleteIds(prompt: string): number[] {
  const lower = prompt.toLowerCase();
  if (/\b(all|everything|all emails|all email|entire mailbox)\b/.test(lower)) {
    return [];
  }

  const ids: number[] = [];
  const rangeRegex = /(\d+)\s*-\s*(\d+)/g;
  let match: RegExpExecArray | null = rangeRegex.exec(prompt);
  while (match) {
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (Number.isFinite(start) && Number.isFinite(end) && start > 0 && end > 0) {
      const min = Math.min(start, end);
      const max = Math.max(start, end);
      const span = max - min + 1;
      if (span <= 500) {
        for (let id = min; id <= max; id += 1) {
          ids.push(id);
        }
      }
    }
    match = rangeRegex.exec(prompt);
  }

  const numberRegex = /\b\d+\b/g;
  const numbers = prompt.match(numberRegex) || [];
  for (const raw of numbers) {
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) {
      ids.push(value);
    }
  }

  return Array.from(new Set(ids)).sort((a, b) => a - b);
}

function parseMarkReadPayload(prompt: string): {
  all?: boolean;
  ids?: number[];
  folder?: string;
  limit?: number;
} {
  const text = prompt.toLowerCase();
  const ids = parseDeleteIds(prompt);
  const folderHint = extractFolderHint(prompt);
  const limit = extractRequestedEmailLimit(prompt);
  const hasAll = /\b(all|everything|entire mailbox|whole mailbox)\b/.test(text);

  if (hasAll) {
    return { all: true };
  }
  if (ids.length > 0) {
    return { ids };
  }
  if (folderHint) {
    return { folder: folderHint };
  }
  if (limit && limit > 0) {
    return { limit };
  }
  return { all: true };
}

function shouldCheckLearningsSql(prompt: string): boolean {
  const text = prompt.toLowerCase();
  return (
    text.includes('learning') ||
    text.includes('learnings') ||
    text.includes('remember') ||
    text.includes('forget') ||
    text.includes('delete learning')
  );
}

async function loadFolderCounts(dbAll: DbAll): Promise<FolderCount[]> {
  const rows = await dbAll(
    `SELECT folders.name as name, folders.path as path, COUNT(email_messages.id) as count
     FROM folders
     LEFT JOIN email_messages ON email_messages.folder_id = folders.id
     GROUP BY folders.id;`,
  );
  return rows.map((row) => ({
    name: row?.name ? String(row.name) : '(unknown)',
    path: row?.path ? String(row.path) : '(unknown)',
    count: Number(row?.count || 0),
  }));
}

function formatFolderLabel(folder: FolderCount): string {
  const name = folder.name?.trim() || folder.path?.trim() || 'Unknown folder';
  return name;
}

function buildSyncSummary(before: FolderCount[], after: FolderCount[]): string {
  const beforeMap = new Map<string, FolderCount>();
  const afterMap = new Map<string, FolderCount>();
  for (const folder of before) {
    beforeMap.set(folder.path, folder);
  }
  for (const folder of after) {
    afterMap.set(folder.path, folder);
  }

  const paths = new Set<string>([...beforeMap.keys(), ...afterMap.keys()]);
  const messages: string[] = [];
  for (const path of paths) {
    const beforeFolder = beforeMap.get(path);
    const afterFolder = afterMap.get(path);
    const beforeCount = beforeFolder?.count ?? 0;
    const afterCount = afterFolder?.count ?? 0;
    const delta = afterCount - beforeCount;
    if (delta === 0) {
      continue;
    }
    const label = formatFolderLabel(afterFolder || beforeFolder || { name: path, path, count: 0 });
    if (delta > 0) {
      messages.push(`Pulled ${delta} new email${delta === 1 ? '' : 's'} in ${label}.`);
    } else {
      const removed = Math.abs(delta);
      messages.push(`Removed ${removed} email${removed === 1 ? '' : 's'} from ${label}.`);
    }
  }

  if (messages.length === 0) {
    return 'Sync complete. No new emails.';
  }
  return messages.join(' ');
}

async function loadSenderMatches(dbAll: DbAll, patterns: string[]): Promise<BlockSenderMatch[]> {
  const results: BlockSenderMatch[] = [];
  for (const pattern of patterns) {
    const lowered = pattern.toLowerCase();
    const rows = await dbAll(
      'SELECT DISTINCT from_raw FROM email_messages WHERE LOWER(from_raw) LIKE ?;',
      `%${lowered}%`,
    );
    const matches = rows
      .map((row) => (row?.from_raw ? String(row.from_raw) : ''))
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    results.push({ pattern, matches });
  }
  return results;
}

function formatBlockConfirm(matches: BlockSenderMatch[]): string {
  const patterns = matches.map((entry) => entry.pattern).join(', ');
  const totalMatches = matches.reduce((sum, entry) => sum + entry.matches.length, 0);
  const details = matches
    .map((entry) => {
      const list = entry.matches.length > 0 ? entry.matches.join('; ') : 'none';
      return `${entry.pattern}: ${list}`;
    })
    .join(' | ');
  return `Confirm blocking sender patterns: ${patterns}. Matches found: ${totalMatches}. ${details}`;
}

async function loadMessageIdsForSenderPatterns(dbAll: DbAll, patterns: string[]): Promise<number[]> {
  const ids = new Set<number>();
  for (const pattern of patterns) {
    const lowered = pattern.toLowerCase();
    const rows = await dbAll(
      `SELECT id
       FROM email_messages
       WHERE LOWER(COALESCE(from_raw, '')) LIKE ?;`,
      `%${lowered}%`,
    );
    for (const row of rows) {
      const id = Number(row?.id);
      if (Number.isFinite(id) && id > 0) {
        ids.add(Math.floor(id));
      }
    }
  }
  return Array.from(ids).sort((a, b) => a - b);
}

async function ensureTrashFolderId(dbGet: DbGet, dbRun: DbRun): Promise<number> {
  let trashFolder = await dbGet(
    `SELECT id, path, name
     FROM folders
     WHERE LOWER(path) = 'trash' OR LOWER(name) = 'trash'
     LIMIT 1;`,
  );
  if (!trashFolder?.id) {
    await dbRun('INSERT INTO folders (name, path) VALUES (?, ?);', 'Trash', 'Trash');
    trashFolder = await dbGet(
      `SELECT id, path, name
       FROM folders
       WHERE LOWER(path) = 'trash' OR LOWER(name) = 'trash'
       LIMIT 1;`,
    );
  }
  const id = Number(trashFolder?.id || 0);
  return Number.isFinite(id) && id > 0 ? id : 0;
}

async function moveMessageIdsToLocalTrash(
  dbGet: DbGet,
  dbRun: DbRun,
  ids: number[],
): Promise<number> {
  const normalized = Array.from(new Set(ids))
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0)
    .map((id) => Math.floor(id));
  if (normalized.length === 0) {
    return 0;
  }
  const trashFolderId = await ensureTrashFolderId(dbGet, dbRun);
  if (trashFolderId <= 0) {
    return 0;
  }
  const placeholders = normalized.map(() => '?').join(', ');
  await dbRun(
    `UPDATE email_messages
     SET folder_id = ?
     WHERE id IN (${placeholders});`,
    trashFolderId,
    ...normalized,
  );
  return normalized.length;
}

async function loadBlockedPatternMatches(dbAll: DbAll, patterns: string[]): Promise<BlockSenderMatch[]> {
  const results: BlockSenderMatch[] = [];
  for (const pattern of patterns) {
    const lowered = pattern.toLowerCase();
    const rows = await dbAll(
      'SELECT DISTINCT pattern FROM blocked_senders WHERE LOWER(pattern) LIKE ?;',
      `%${lowered}%`,
    );
    const matches = rows
      .map((row) => (row?.pattern ? String(row.pattern) : ''))
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    results.push({ pattern, matches });
  }
  return results;
}

function formatUnblockConfirm(matches: BlockSenderMatch[]): string {
  const requested = matches.map((entry) => entry.pattern).join(', ');
  const totalMatches = matches.reduce((sum, entry) => sum + entry.matches.length, 0);
  const details = matches
    .map((entry) => {
      const list = entry.matches.length > 0 ? entry.matches.join('; ') : 'none';
      return `${entry.pattern}: ${list}`;
    })
    .join(' | ');
  return `Confirm unblocking sender patterns: ${requested}. Matches found: ${totalMatches}. ${details}`;
}

async function loadExistingMessageIds(dbAll: DbAll, ids: number[]): Promise<number[]> {
  if (ids.length === 0) {
    return [];
  }
  const placeholders = ids.map(() => '?').join(', ');
  const rows = await dbAll(
    `SELECT id FROM email_messages WHERE id IN (${placeholders});`,
    ...ids,
  );
  return rows
    .map((row) => Number(row?.id))
    .filter((value) => Number.isFinite(value) && value > 0);
}

async function loadFollowUpContext(dbGet: DbGet, dbAll: DbAll): Promise<FollowUpTurn[]> {
  const state = await dbGet(
    'SELECT is_active FROM llm_followup_state WHERE session_key = ? LIMIT 1;',
    FOLLOW_UP_SESSION_KEY,
  );
  if (!state || Number(state.is_active) !== 1) {
    return [];
  }
  const rows = await dbAll(
    `SELECT user_prompt, llm_reply, created_at
     FROM llm_followup_turns
     WHERE session_key = ?
     ORDER BY id ASC
     LIMIT ?;`,
    FOLLOW_UP_SESSION_KEY,
    FOLLOW_UP_MAX_TURNS,
  );
  return rows.map((row) => ({
    user_prompt: String(row?.user_prompt || ''),
    llm_reply: String(row?.llm_reply || ''),
    created_at: row?.created_at ? String(row.created_at) : null,
  }));
}

async function setFollowUpActive(dbRun: DbRun, active: boolean): Promise<void> {
  await dbRun(
    `INSERT INTO llm_followup_state (session_key, is_active, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(session_key) DO UPDATE SET
       is_active = excluded.is_active,
       updated_at = CURRENT_TIMESTAMP;`,
    FOLLOW_UP_SESSION_KEY,
    active ? 1 : 0,
  );
}

async function appendFollowUpTurn(dbRun: DbRun, userPrompt: string, llmReply: string): Promise<void> {
  await dbRun(
    `INSERT INTO llm_followup_turns (session_key, user_prompt, llm_reply)
     VALUES (?, ?, ?);`,
    FOLLOW_UP_SESSION_KEY,
    userPrompt,
    llmReply,
  );
  await dbRun(
    `DELETE FROM llm_followup_turns
     WHERE session_key = ?
       AND id NOT IN (
         SELECT id
         FROM llm_followup_turns
         WHERE session_key = ?
         ORDER BY id DESC
         LIMIT ?
       );`,
    FOLLOW_UP_SESSION_KEY,
    FOLLOW_UP_SESSION_KEY,
    FOLLOW_UP_MAX_TURNS,
  );
}

async function resetFollowUpContext(dbRun: DbRun): Promise<void> {
  await dbRun('DELETE FROM llm_followup_turns WHERE session_key = ?;', FOLLOW_UP_SESSION_KEY);
  await setFollowUpActive(dbRun, false);
}

function parseLearningExtract(raw: string): LearningExtract | null {
  try {
    const outer = JSON.parse(raw) as { msg?: string; message?: { content?: string } };
    let content: string | undefined;
    if (typeof outer.msg === 'string') {
      const inner = JSON.parse(outer.msg) as { message?: { content?: string } };
      content = inner.message?.content;
    } else if (outer.message?.content && typeof outer.message.content === 'string') {
      content = outer.message.content;
    }

    if (!content) {
      return null;
    }

    const parsed = JSON.parse(content) as LearningExtract;
    if (typeof parsed.should_learn !== 'boolean') {
      return null;
    }
    if (parsed.learning && typeof parsed.learning !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function parseLearningsSql(raw: string): LearningsSqlResult | null {
  try {
    const outer = JSON.parse(raw) as { msg?: string; message?: { content?: string } };
    let content: string | undefined;
    if (typeof outer.msg === 'string') {
      const inner = JSON.parse(outer.msg) as { message?: { content?: string } };
      content = inner.message?.content;
    } else if (outer.message?.content && typeof outer.message.content === 'string') {
      content = outer.message.content;
    }

    if (!content) {
      return null;
    }

    const parsed = JSON.parse(content) as LearningsSqlResult;
    if (parsed.action !== 'list' && parsed.action !== 'delete' && parsed.action !== 'none') {
      return null;
    }
    if (typeof parsed.sql !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function parseEmailSql(raw: string): EmailSqlResult | null {
  try {
    const outer = JSON.parse(raw) as { msg?: string; message?: { content?: string } };
    let content: string | undefined;
    if (typeof outer.msg === 'string') {
      const inner = JSON.parse(outer.msg) as { message?: { content?: string } };
      content = inner.message?.content;
    } else if (outer.message?.content && typeof outer.message.content === 'string') {
      content = outer.message.content;
    }

    if (!content) {
      return null;
    }

    const parsed = JSON.parse(content) as EmailSqlResult;
    if (typeof parsed.sql !== 'string') {
      return null;
    }
    if (
      parsed.delivery !== undefined &&
      parsed.delivery !== 'attach' &&
      parsed.delivery !== 'read' &&
      parsed.delivery !== 'none'
    ) {
      return null;
    }
    if (
      parsed.follow_up_question !== undefined &&
      typeof parsed.follow_up_question !== 'boolean'
    ) {
      return null;
    }
    if (
      parsed.follow_up_message !== undefined &&
      typeof parsed.follow_up_message !== 'string'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function parseReplyExtract(raw: string): ReplyExtractResult | null {
  try {
    const outer = JSON.parse(raw) as { msg?: string; message?: { content?: string } };
    let content: string | undefined;
    if (typeof outer.msg === 'string') {
      const inner = JSON.parse(outer.msg) as { message?: { content?: string } };
      content = inner.message?.content;
    } else if (outer.message?.content && typeof outer.message.content === 'string') {
      content = outer.message.content;
    }

    if (!content) {
      return null;
    }

    const parsed = JSON.parse(content) as ReplyExtractResult;
    if (parsed.mode !== 'by_id' && parsed.mode !== 'search' && parsed.mode !== 'unknown') {
      return null;
    }
    if (parsed.email_id !== undefined) {
      const id = Number(parsed.email_id);
      if (!Number.isFinite(id)) {
        return null;
      }
      if (id > 0) {
        parsed.email_id = Math.floor(id);
      } else {
        delete parsed.email_id;
      }
    }
    if (parsed.search_query !== undefined && typeof parsed.search_query !== 'string') {
      return null;
    }
    if (parsed.subject !== undefined && typeof parsed.subject !== 'string') {
      return null;
    }
    if (parsed.body !== undefined && typeof parsed.body !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function parseReplyBodyDerive(raw: string): ReplyBodyDeriveResult | null {
  try {
    const outer = JSON.parse(raw) as { msg?: string; message?: { content?: string } };
    let content: string | undefined;
    if (typeof outer.msg === 'string') {
      const inner = JSON.parse(outer.msg) as { message?: { content?: string } };
      content = inner.message?.content;
    } else if (outer.message?.content && typeof outer.message.content === 'string') {
      content = outer.message.content;
    }

    if (!content) {
      return null;
    }
    const parsed = JSON.parse(content) as ReplyBodyDeriveResult;
    if (typeof parsed.body !== 'string') {
      return null;
    }
    return { body: parsed.body.trim() };
  } catch {
    return null;
  }
}

function parseEmailReadSummary(raw: string): EmailReadSummaryResult | null {
  try {
    const outer = JSON.parse(raw) as { msg?: string; message?: { content?: string } };
    let content: string | undefined;
    if (typeof outer.msg === 'string') {
      const inner = JSON.parse(outer.msg) as { message?: { content?: string } };
      content = inner.message?.content;
    } else if (outer.message?.content && typeof outer.message.content === 'string') {
      content = outer.message.content;
    }

    if (!content) {
      return null;
    }
    const parsed = JSON.parse(content) as EmailReadSummaryResult;
    if (
      typeof parsed.email_id !== 'string' ||
      typeof parsed.from !== 'string' ||
      typeof parsed.to !== 'string' ||
      !Array.isArray(parsed.cc) ||
      !Array.isArray(parsed.bcc) ||
      typeof parsed.subject !== 'string' ||
      typeof parsed.received_at !== 'string' ||
      typeof parsed.folder !== 'string' ||
      typeof parsed.subfolder !== 'string' ||
      typeof parsed.body_text !== 'string' ||
      typeof parsed.body_html !== 'string' ||
      typeof parsed.ai_summary !== 'string' ||
      !Array.isArray(parsed.attachments)
    ) {
      return null;
    }
    const cc = parsed.cc.filter((item): item is string => typeof item === 'string').map((item) => item.trim());
    const bcc = parsed.bcc.filter((item): item is string => typeof item === 'string').map((item) => item.trim());
    const attachments = parsed.attachments
      .filter((item) => item && typeof item === 'object')
      .map((item) => {
        const candidate = item as { id?: unknown; name?: unknown; mime_type?: unknown; size_bytes?: unknown };
        const rawSize = Number(candidate.size_bytes);
        return {
          id: typeof candidate.id === 'string' ? candidate.id : '',
          name: typeof candidate.name === 'string' ? candidate.name : '',
          mime_type: typeof candidate.mime_type === 'string' ? candidate.mime_type : '',
          size_bytes: Number.isFinite(rawSize) ? rawSize : 0,
        };
      });
    return {
      email_id: parsed.email_id.trim(),
      from: parsed.from.trim(),
      to: parsed.to.trim(),
      cc,
      bcc,
      subject: parsed.subject.trim(),
      received_at: parsed.received_at.trim(),
      folder: parsed.folder.trim(),
      subfolder: parsed.subfolder.trim(),
      body_text: parsed.body_text,
      body_html: parsed.body_html,
      ai_summary: parsed.ai_summary.trim(),
      attachments,
    };
  } catch {
    return null;
  }
}

function parseAttachmentExplain(raw: string): AttachmentExplainResult | null {
  try {
    const outer = JSON.parse(raw) as { msg?: string; message?: { content?: string } };
    let content: string | undefined;
    if (typeof outer.msg === 'string') {
      const inner = JSON.parse(outer.msg) as { message?: { content?: string } };
      content = inner.message?.content;
    } else if (outer.message?.content && typeof outer.message.content === 'string') {
      content = outer.message.content;
    }

    if (!content) {
      return null;
    }

    const parsed = JSON.parse(content) as AttachmentExplainResult;
    if (typeof parsed.message !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').trim();
}

function isInvalidSummaryText(value: string): boolean {
  const text = String(value || '').trim().toLowerCase();
  if (!text) {
    return true;
  }
  return (
    text.includes('email service is unavailable') ||
    text.includes('endpoint unreachable') ||
    text.includes('operation was aborted') ||
    text.includes('timed out') ||
    text.includes('timeout') ||
    text.includes('fetch failed') ||
    text.includes('connection refused') ||
    text.includes('service unavailable')
  );
}

function formatReceivedAtHuman(value: unknown): string {
  if (value === null || value === undefined) {
    return '(unknown date)';
  }
  const raw = String(value).trim();
  if (!raw) {
    return '(unknown date)';
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    return raw;
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  // WhatsApp-safe: avoid long bare number runs and time colon.
  return `${year}/${month}/${day} ${hour}h${minute}`;
}

function parseAttachments(value: unknown): string[] {
  if (typeof value !== 'string') {
    return [];
  }
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function parseAddressItems(value: unknown): string[] {
  if (typeof value !== 'string') {
    return [];
  }
  return value
    .split(/[;,]/g)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function splitFolderPath(pathValue: unknown): { folder: string; subfolder: string } {
  const raw = typeof pathValue === 'string' ? pathValue.trim() : '';
  if (!raw) {
    return { folder: '', subfolder: '' };
  }
  const parts = raw.split('.').map((part) => part.trim()).filter((part) => part.length > 0);
  if (parts.length === 0) {
    return { folder: raw, subfolder: '' };
  }
  return {
    folder: parts[0] || '',
    subfolder: parts.slice(1).join('.') || '',
  };
}

function parseAttachmentIds(value: unknown): number[] {
  if (typeof value !== 'string') {
    return [];
  }
  return value
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => Math.floor(value));
}

function buildUiActionsForEmailRows(rows: any[], sourceChannel?: string): UiAction[] | undefined {
  if (isWhatsappChannel(sourceChannel) || !Array.isArray(rows) || rows.length === 0) {
    return undefined;
  }
  const actions: UiAction[] = [];
  for (const row of rows) {
    const id = Number(row?.id);
    if (!Number.isFinite(id) || id <= 0) {
      continue;
    }
    const normalizedId = Math.floor(id);
    pushUiAction(actions, makePrefillAction(`Read Email ${normalizedId}`, `read email ${normalizedId}`));
    pushUiAction(
      actions,
      makePrefillAction(`Reply Email ${normalizedId}`, `reply to email ${normalizedId} with body `),
    );
    const names = parseAttachments(row?.attachments);
    const ids = parseAttachmentIds(row?.attachment_ids);
    const explicitAttachmentId = Number(row?.attachment_id);
    const hasAttachments =
      names.length > 0 ||
      ids.length > 0 ||
      (Number.isFinite(explicitAttachmentId) && explicitAttachmentId > 0);
    if (hasAttachments) {
      pushUiAction(
        actions,
        makePrefillAction(`Show Attachments ${normalizedId}`, `show attachments for id ${normalizedId}`),
      );
    }
  }
  return actions.length > 0 ? actions : undefined;
}

function buildUiActionsForAttachmentRows(
  emailId: number,
  attachmentRows: Array<{ id?: number; attachment_id?: number }>,
  sourceChannel?: string,
): UiAction[] | undefined {
  if (isWhatsappChannel(sourceChannel)) {
    return undefined;
  }
  const actions: UiAction[] = [];
  if (Number.isFinite(emailId) && emailId > 0) {
    const normalizedEmailId = Math.floor(emailId);
    pushUiAction(actions, makePrefillAction(`Read Email ${normalizedEmailId}`, `read email ${normalizedEmailId}`));
    pushUiAction(
      actions,
      makePrefillAction(`Reply Email ${normalizedEmailId}`, `reply to email ${normalizedEmailId} with body `),
    );
    pushUiAction(
      actions,
      makePrefillAction(`Show Attachments ${normalizedEmailId}`, `show attachments for id ${normalizedEmailId}`),
    );
  }
  for (const row of attachmentRows || []) {
    const id = Number(row?.attachment_id ?? row?.id);
    if (!Number.isFinite(id) || id <= 0) {
      continue;
    }
    const normalizedId = Math.floor(id);
    pushUiAction(
      actions,
      makePrefillAction(`Download Attachment ${normalizedId}`, `download attachment ${normalizedId}`),
    );
  }
  return actions.length > 0 ? actions : undefined;
}

function buildUiActionsForReplyCandidates(
  candidates: Array<{ id: number }>,
  sourceChannel?: string,
): UiAction[] | undefined {
  if (isWhatsappChannel(sourceChannel) || !Array.isArray(candidates) || candidates.length === 0) {
    return undefined;
  }
  const actions: UiAction[] = [];
  for (const row of candidates) {
    const id = Number(row?.id);
    if (!Number.isFinite(id) || id <= 0) {
      continue;
    }
    const normalizedId = Math.floor(id);
    pushUiAction(actions, makePrefillAction(`Read Email ${normalizedId}`, `read email ${normalizedId}`));
    pushUiAction(
      actions,
      makePrefillAction(`Reply Email ${normalizedId}`, `reply to email ${normalizedId} with `),
    );
  }
  return actions.length > 0 ? actions : undefined;
}

function formatAggregateRows(rows: any[]): string {
  if (!Array.isArray(rows) || rows.length === 0) {
    return 'No results.';
  }
  const row = rows[0] ?? {};
  const entries = Object.entries(row);
  if (entries.length === 0) {
    return 'No results.';
  }
  const lines = entries.map(([key, value]) => `${key}: ${value ?? 0}`);
  return lines.join('\n');
}

function isAggregateOnlyRow(row: any): boolean {
  if (!row || typeof row !== 'object') return false;
  const keys = Object.keys(row);
  if (keys.length === 0) return false;
  const dataKeys = ['id', 'from_raw', 'from', 'subject', 'received_at', 'text_body', 'attachments'];
  if (keys.some((key) => dataKeys.includes(key))) {
    return false;
  }
  return true;
}

function formatEmailRowsBasic(rows: any[], sourceChannel?: string): string {
  if (!Array.isArray(rows) || rows.length === 0) {
    return 'No matching emails were found.';
  }
  if (rows.length > 0 && isAggregateOnlyRow(rows[0])) {
    return formatAggregateRows(rows);
  }
  const grouped = new Map<
    string,
    {
      id: string | number;
      from: string;
      subject: string;
      receivedAt: string;
      names: string[];
      ids: number[];
    }
  >();

  for (const row of rows) {
    const id = row.id ?? '(unknown id)';
    const key = String(id);
    const from = String(row.from_raw ?? row.from ?? '(unknown sender)');
    const subject = String(row.subject ?? '(no subject)');
    const receivedAt = formatReceivedAtHuman(row.received_at);
    const names = parseAttachments(row.attachments);
    const idsFromAggregate = parseAttachmentIds(row.attachment_ids);
    const explicitAttachmentId = Number(row.attachment_id);
    const explicitAttachmentName =
      typeof row.filename === 'string' && row.filename.trim().length > 0
        ? row.filename.trim()
        : null;

    if (!grouped.has(key)) {
      grouped.set(key, { id, from, subject, receivedAt, names: [], ids: [] });
    }
    const entry = grouped.get(key)!;
    for (const name of names) {
      // Preserve duplicate filenames so repeated attachments (same name, different IDs) remain visible.
      entry.names.push(name);
    }
    for (const attachmentId of idsFromAggregate) {
      if (!entry.ids.includes(attachmentId)) {
        entry.ids.push(attachmentId);
      }
    }
    if (Number.isFinite(explicitAttachmentId) && explicitAttachmentId > 0) {
      const normalizedId = Math.floor(explicitAttachmentId);
      if (!entry.ids.includes(normalizedId)) {
        entry.ids.push(normalizedId);
      }
      if (explicitAttachmentName && !entry.names.includes(explicitAttachmentName)) {
        entry.names.push(explicitAttachmentName);
      }
    }
  }

  const blocks = Array.from(grouped.values()).map((entry) => {
    const isWhatsapp = isWhatsappChannel(sourceChannel);
    let attachmentSummary = 'no';
    if (entry.ids.length > 0 && entry.names.length > 0 && entry.ids.length === entry.names.length) {
      attachmentSummary = entry.ids.map((id, idx) => `${id}: ${entry.names[idx]}`).join(', ');
    } else if (entry.ids.length > 0 && entry.names.length > 0) {
      attachmentSummary = `${entry.names.join(', ')} (attachment ids: ${entry.ids.join(', ')})`;
    } else if (entry.ids.length > 0 && entry.names.length === 0) {
      attachmentSummary = entry.ids.join(', ');
    } else if (entry.names.length > 0) {
      attachmentSummary = entry.names.join(', ');
    }
    const uiActions = !isWhatsapp
      ? buildUiActionsForEmailRows(
          [
            {
              id: entry.id,
              attachments: entry.names.join(', '),
              attachment_ids: entry.ids.join(', '),
            },
          ],
          sourceChannel,
        )
      : undefined;
    const { readInlineAction, otherInlineActions } = !isWhatsapp
      ? extractReadInlineAction(uiActions)
      : { readInlineAction: undefined, otherInlineActions: [] };
    const idLine = !isWhatsapp && readInlineAction
      ? `${formatEmailIdLabel(entry.id, sourceChannel)} ${readInlineAction}`
      : formatEmailIdLabel(entry.id, sourceChannel);
    return [
      idLine,
      ...(isWhatsapp ? [`Read Link: ${buildReadEmailLink(entry.id, sourceChannel)}`] : []),
      `From: ${entry.from}`,
      `Subject: ${entry.subject}`,
      `Received: ${entry.receivedAt}`,
      ...(isWhatsapp
        ? [`Attachments: ${attachmentSummary === 'no' ? 'no' : 'yes'}`]
        : [`Attachments: ${attachmentSummary}`]),
      ...(isWhatsapp && attachmentSummary !== 'no'
        ? [`Attachments Link: ${buildShowAttachmentsLink(entry.id, sourceChannel)}`]
        : []),
      ...(!isWhatsapp ? otherInlineActions : []),
    ].join('\n');
  });
  return blocks.join('\n\n');
}

function formatEmailRowsDetailed(rows: any[], sourceChannel?: string): string {
  if (!Array.isArray(rows) || rows.length === 0) {
    return 'No matching emails were found.';
  }
  const blocks = rows.map((row) => {
    const isWhatsapp = isWhatsappChannel(sourceChannel);
    const id = row.id ?? '(unknown id)';
    const from = row.from_raw ?? row.from ?? '(unknown sender)';
    const subject = row.subject ?? '(no subject)';
    const receivedAt = formatReceivedAtHuman(row.received_at);
    const attachments = parseAttachments(row.attachments);
    const body =
      typeof row.text_body === 'string' && row.text_body.trim().length > 0
        ? normalizeWhitespace(row.text_body)
        : '(no body)';
    const uiActions = !isWhatsapp ? buildUiActionsForEmailRows([row], sourceChannel) : undefined;
    const { readInlineAction, otherInlineActions } = !isWhatsapp
      ? extractReadInlineAction(uiActions)
      : { readInlineAction: undefined, otherInlineActions: [] };
    const idLine = !isWhatsapp && readInlineAction
      ? `${formatEmailIdLabel(id, sourceChannel)} ${readInlineAction}`
      : formatEmailIdLabel(id, sourceChannel);
    if (!isWhatsapp) {
      return [
        '<article class="email-card">',
        `<p><strong>${escapeHtml(idLine)}</strong></p>`,
        `<p><strong>From:</strong> ${escapeHtml(from)}</p>`,
        `<p><strong>Subject:</strong> ${escapeHtml(subject)}</p>`,
        `<p><strong>Received:</strong> ${escapeHtml(receivedAt)}</p>`,
        `<p><strong>Attachments:</strong> ${escapeHtml(attachments.length > 0 ? attachments.join(', ') : 'no')}</p>`,
        ...otherInlineActions.map((line) => `<p>${escapeHtml(line)}</p>`),
        '<div><strong>Body:</strong></div>',
        `<div>${renderEmailBodyAsHtml(body)}</div>`,
        '</article>',
      ].join('\n');
    }
    return [
      idLine,
      ...(isWhatsapp ? [`Read Link: ${buildReadEmailLink(id, sourceChannel)}`] : []),
      `From: ${from}`,
      `Subject: ${subject}`,
      `Received: ${receivedAt}`,
      ...(isWhatsapp
        ? [`Attachments: ${attachments.length > 0 ? 'yes' : 'no'}`]
        : [`Attachments: ${attachments.length > 0 ? attachments.join(', ') : 'no'}`]),
      ...(isWhatsapp && attachments.length > 0
        ? [`Attachments Link: ${buildShowAttachmentsLink(id, sourceChannel)}`]
        : []),
      ...(!isWhatsapp ? otherInlineActions : []),
      `Body: ${body}`,
    ].join('\n');
  });
  return blocks.join('\n\n');
}

function isDetailedEmailRequest(prompt: string): boolean {
  const text = prompt.toLowerCase();
  return /\b(detailed|detail|complete|full|entire|with body|body)\b/.test(text);
}

async function enrichRowsWithTextBody(dbAll: DbAll, rows: any[]): Promise<any[]> {
  if (!Array.isArray(rows) || rows.length === 0) {
    return rows;
  }
  const ids = Array.from(
    new Set(
      rows
        .map((row) => Number(row?.id))
        .filter((id) => Number.isFinite(id) && id > 0)
        .map((id) => Math.floor(id)),
    ),
  );
  if (ids.length === 0) {
    return rows;
  }
  const placeholders = ids.map(() => '?').join(', ');
  const bodyRows = await dbAll(
    `SELECT id, text_body FROM email_messages WHERE id IN (${placeholders});`,
    ...ids,
  );
  const bodyById = new Map<number, string | null>();
  for (const row of bodyRows || []) {
    const id = Number(row?.id);
    if (!Number.isFinite(id) || id <= 0) continue;
    bodyById.set(Math.floor(id), typeof row?.text_body === 'string' ? row.text_body : null);
  }
  return rows.map((row) => {
    const id = Number(row?.id);
    if (!Number.isFinite(id) || id <= 0) return row;
    if (typeof row?.text_body === 'string' && row.text_body.trim().length > 0) return row;
    const textBody = bodyById.get(Math.floor(id));
    if (textBody === undefined) return row;
    return { ...row, text_body: textBody };
  });
}

function buildLearningExtractPrompt(payload: LlmPayload) {
  const template = loadPrompt('learnings_extract');
  return {
    system: 'You are a helper. Respond ONLY in structured JSON.',
    user: buildPromptMessage(
      template,
      {
        payload: JSON.stringify(payload),
      },
      cachedLearnings,
    ),
  };
}

function buildLearningsSqlPrompt(payload: LlmPayload) {
  const template = loadPrompt('learnings_sql');
  return {
    system: 'You are a helper. Respond ONLY in structured JSON.',
    user: buildPromptMessage(
      template,
      {
        payload: JSON.stringify(payload),
      },
      cachedLearnings,
    ),
  };
}

function buildEmailSqlPrompt(payload: LlmPayload) {
  const template = loadPrompt('email_sql');
  return {
    system: 'You are a helper. Respond ONLY in structured JSON.',
    user: buildPromptMessage(
      template,
      {
        payload: JSON.stringify(payload),
      },
      cachedLearnings,
    ),
  };
}

function buildReplyExtractPrompt(payload: LlmPayload) {
  const template = loadPrompt('reply_extract');
  return {
    system: 'You are a helper. Respond ONLY in structured JSON.',
    user: buildPromptMessage(
      template,
      {
        payload: JSON.stringify(payload),
      },
      cachedLearnings,
    ),
  };
}

function buildReplyBodyDerivePrompt(payload: LlmPayload) {
  const template = loadPrompt('reply_body_derive');
  return {
    system: 'You are a helper. Respond ONLY in structured JSON.',
    user: buildPromptMessage(
      template,
      {
        payload: JSON.stringify(payload),
      },
      cachedLearnings,
    ),
  };
}

function buildEmailReadSummaryPrompt(payload: {
  prompt: string;
  email: {
    id: number;
    from_raw: string | null;
    to_raw: string | null;
    cc_raw: string | null;
    bcc_raw: string | null;
    subject: string | null;
    received_at: string | null;
    folder: string | null;
    subfolder: string | null;
    text_body: string | null;
    html_body: string | null;
  };
  attachments: Array<{
    id: number;
    filename: string | null;
    content_type: string | null;
    size: number | null;
  }>;
  pdf_extractions: Array<{
    attachment_id: number;
    filename: string | null;
    extracted_text: string;
  }>;
}) {
  const template = loadPrompt('email_read_summary');
  return {
    system: 'You are a helper. Respond ONLY in structured JSON.',
    user: buildPromptMessage(
      template,
      {
        payload: JSON.stringify(payload),
      },
      cachedLearnings,
    ),
  };
}

function buildAttachmentExplainPrompt(payload: {
  prompt: string;
  attachment: AttachmentCandidate;
  extractedText: string;
}) {
  const template = loadPrompt('attachment_explain');
  const serialized = JSON.stringify({
    prompt: payload.prompt,
    attachment: {
      attachment_id: payload.attachment.attachment_id,
      email_id: payload.attachment.email_id,
      filename: payload.attachment.filename,
      content_type: payload.attachment.content_type,
      folder_name: payload.attachment.folder_name,
      folder_path: payload.attachment.folder_path,
      subject: payload.attachment.subject,
      from_raw: payload.attachment.from_raw,
      received_at: payload.attachment.received_at,
    },
    extracted_text: payload.extractedText,
  });
  return {
    system: 'You are a helper. Respond ONLY in structured JSON.',
    user: buildPromptMessage(
      template,
      {
        payload: serialized,
      },
      [],
    ),
  };
}

async function ensureLearningsDb(): Promise<void> {
  if (learningsDb) {
    return;
  }
  const dbPath = path.resolve(CURRENT_DIR, '..', 'data', 'learnings.db');
  learningsDb = new sqlite3.Database(dbPath);
  learningsDbGet = promisify(learningsDb.get.bind(learningsDb));
  learningsDbRun = promisify(learningsDb.run.bind(learningsDb));
  learningsDbAll = promisify(learningsDb.all.bind(learningsDb));
  const dbExec = promisify(learningsDb.exec.bind(learningsDb));
  await dbExec(
    "CREATE TABLE IF NOT EXISTS learnings (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));",
  );
}

async function refreshLearnings(): Promise<string[]> {
  await ensureLearningsDb();
  const rows = await learningsDbAll(
    'SELECT content FROM learnings ORDER BY id ASC;',
  );
  cachedLearnings = rows
    .map((row) => (row?.content ? String(row.content) : ''))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return cachedLearnings;
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

async function appendLearning(content: string): Promise<void> {
  await ensureLearningsDb();
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return;
  }
  await learningsDbRun(
    `INSERT INTO learnings (content) VALUES ('${escapeSqlLiteral(trimmed)}');`,
  );
  await refreshLearnings();
}

function isSafeLearningsSql(sql: string): boolean {
  const normalized = sql.trim().toLowerCase();
  if (normalized.startsWith('select')) {
    return normalized.includes(' from learnings');
  }
  if (normalized.startsWith('delete')) {
    return normalized.includes(' from learnings');
  }
  return false;
}

async function runLearningsSql(sql: string): Promise<{ rows: string[]; deleted: number | null }> {
  await ensureLearningsDb();
  if (!isSafeLearningsSql(sql)) {
    return { rows: [], deleted: null };
  }
  if (sql.trim().toLowerCase().startsWith('select')) {
    const rows = await learningsDbAll(sql);
    const formatted = rows.map((row) =>
      [row?.id, row?.content, row?.created_at].filter((value) => value !== undefined).join('|'),
    );
    return { rows: formatted, deleted: null };
  }
  await learningsDbRun(sql);
  return { rows: [], deleted: 0 };
}

function formatLearningsRows(rows: string[]): string {
  if (rows.length === 0) {
    return 'No learnings found.';
  }
  const formatted = rows.map((row) => {
    const parts = row.split('|');
    if (parts.length >= 3) {
      const [id, content, createdAt] = parts;
      return `#${id}: ${content} (${createdAt})`;
    }
    return row;
  });
  return formatted.join('\n');
}

function attachmentCacheKeyFor(attachmentId: number, prompt: string): string {
  return `${attachmentId}||${prompt.trim().toLowerCase()}`;
}

function trimAttachmentTextForPrompt(text: string): string {
  const normalized = normalizeWhitespace(text);
  const maxLength = 12000;
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}\n...[truncated]`;
}

function attachmentIsPdf(attachment: AttachmentCandidate): boolean {
  const contentType = (attachment.content_type || '').toLowerCase();
  const filename = (attachment.filename || '').toLowerCase();
  return contentType.includes('pdf') || filename.endsWith('.pdf');
}

async function loadAttachmentBufferFromStoragePath(storagePath: string): Promise<Buffer> {
  const raw = await readAttachmentFile(storagePath, process.env.ATTACHMENTS_DIR || './attachments');
  try {
    const parsed = JSON.parse(raw.toString('utf-8')) as { content_base64?: unknown };
    if (typeof parsed.content_base64 === 'string' && parsed.content_base64.length > 0) {
      return Buffer.from(parsed.content_base64, 'base64');
    }
  } catch {
    // Ignore: this can be a raw PDF file path.
  }
  return raw;
}

async function extractPdfTextFromBuffer(pdfBuffer: Buffer): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const parser = new PDFParser(undefined, true, PDF_DEFAULT_PASSWORD || undefined);
    parser.on('pdfParser_dataError', (errData: any) => {
      const reason =
        errData?.parserError?.message ||
        errData?.parserError ||
        errData?.message ||
        'PDF parse failed';
      reject(new Error(String(reason)));
    });
    parser.on('pdfParser_dataReady', () => {
      try {
        const content = parser.getRawTextContent();
        resolve(normalizeWhitespace(content || ''));
      } catch (error: any) {
        reject(new Error(error?.message || 'Failed to read extracted PDF text'));
      }
    });
    try {
      parser.parseBuffer(pdfBuffer, 0);
    } catch (error: any) {
      reject(new Error(error?.message || 'Unable to parse PDF buffer'));
    }
  });
}

async function resolveAttachmentCandidate(
  dbAll: DbAll,
  prompt: string,
  options?: { requirePdf?: boolean; excludePdf?: boolean },
): Promise<AttachmentCandidate | null> {
  const requirePdf = options?.requirePdf === true;
  const excludePdf = options?.excludePdf === true;
  const fileFilter = requirePdf
    ? "(LOWER(email_attachments.content_type) LIKE '%pdf%' OR LOWER(email_attachments.filename) LIKE '%.pdf')"
    : excludePdf
      ? "NOT (LOWER(email_attachments.content_type) LIKE '%pdf%' OR LOWER(email_attachments.filename) LIKE '%.pdf')"
      : '1 = 1';
  const firstMail = isFirstMailReference(prompt);
  const orderDirection = firstMail ? 'ASC' : 'DESC';
  const orderBy = `ORDER BY email_messages.received_at ${orderDirection}, email_messages.id ${orderDirection}, email_attachments.id ${orderDirection}`;
  const attachmentId = extractAttachmentIdForRequest(prompt);
  const emailId = extractEmailIdForAttachment(prompt);

  if (!attachmentId && !emailId && isLastMailReference(prompt)) {
    const latestRows = await dbAll(
      `SELECT
         email_attachments.id AS attachment_id,
         email_attachments.email_id AS email_id,
         email_attachments.filename AS filename,
         email_attachments.content_type AS content_type,
         email_attachments.storage_path AS storage_path,
         email_attachments.part AS part,
         folders.name AS folder_name,
         folders.path AS folder_path,
         email_messages.subject AS subject,
         email_messages.from_raw AS from_raw,
         email_messages.received_at AS received_at
       FROM email_messages
       INNER JOIN folders ON email_messages.folder_id = folders.id
       INNER JOIN email_attachments ON email_attachments.email_id = email_messages.id
       WHERE ${fileFilter}
       ORDER BY email_messages.received_at DESC, email_messages.id DESC, email_attachments.id DESC
       LIMIT 1;`,
    );
    if (latestRows && latestRows.length > 0) {
      const row = latestRows[0];
      return {
        attachment_id: Number(row?.attachment_id),
        email_id: Number(row?.email_id),
        filename: row?.filename ? String(row.filename) : null,
        content_type: row?.content_type ? String(row.content_type) : null,
        storage_path: row?.storage_path ? String(row.storage_path) : null,
        part: row?.part ? String(row.part) : null,
        folder_name: row?.folder_name ? String(row.folder_name) : null,
        folder_path: row?.folder_path ? String(row.folder_path) : null,
        subject: row?.subject ? String(row.subject) : null,
        from_raw: row?.from_raw ? String(row.from_raw) : null,
        received_at: row?.received_at ? String(row.received_at) : null,
      };
    }
    return null;
  }

  const filenameHint = extractAttachmentFilenameHint(prompt);
  const folderHint = extractFolderHint(prompt);
  const clauses = [fileFilter];
  const params: unknown[] = [];

  if (attachmentId && Number.isFinite(attachmentId) && attachmentId > 0) {
    clauses.push('email_attachments.id = ?');
    params.push(attachmentId);
  }
  if (emailId && Number.isFinite(emailId) && emailId > 0) {
    clauses.push('email_messages.id = ?');
    params.push(emailId);
  }
  if (filenameHint) {
    clauses.push('LOWER(email_attachments.filename) LIKE ?');
    params.push(`%${filenameHint.toLowerCase()}%`);
  }
  if (folderHint) {
    clauses.push('(LOWER(folders.name) = ? OR LOWER(folders.path) LIKE ?)');
    params.push(folderHint, `%${folderHint}%`);
  }

  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = await dbAll(
    `SELECT
       email_attachments.id AS attachment_id,
       email_attachments.email_id AS email_id,
       email_attachments.filename AS filename,
       email_attachments.content_type AS content_type,
       email_attachments.storage_path AS storage_path,
       email_attachments.part AS part,
       folders.name AS folder_name,
       folders.path AS folder_path,
       email_messages.subject AS subject,
       email_messages.from_raw AS from_raw,
       email_messages.received_at AS received_at
     FROM email_attachments
     INNER JOIN email_messages ON email_attachments.email_id = email_messages.id
     INNER JOIN folders ON email_messages.folder_id = folders.id
     ${whereSql}
     ${orderBy}
     LIMIT 10;`,
    ...params,
  );

  if (!rows || rows.length === 0) {
    return null;
  }

  const row = rows[0];
  return {
    attachment_id: Number(row?.attachment_id),
    email_id: Number(row?.email_id),
    filename: row?.filename ? String(row.filename) : null,
    content_type: row?.content_type ? String(row.content_type) : null,
    storage_path: row?.storage_path ? String(row.storage_path) : null,
    part: row?.part ? String(row.part) : null,
    folder_name: row?.folder_name ? String(row.folder_name) : null,
    folder_path: row?.folder_path ? String(row.folder_path) : null,
    subject: row?.subject ? String(row.subject) : null,
    from_raw: row?.from_raw ? String(row.from_raw) : null,
    received_at: row?.received_at ? String(row.received_at) : null,
  };
}

async function resolveAttachmentCandidates(
  dbAll: DbAll,
  prompt: string,
  options?: { requirePdf?: boolean; excludePdf?: boolean },
): Promise<AttachmentCandidate[]> {
  const requirePdf = options?.requirePdf === true;
  const excludePdf = options?.excludePdf === true;
  const fileFilter = requirePdf
    ? "(LOWER(email_attachments.content_type) LIKE '%pdf%' OR LOWER(email_attachments.filename) LIKE '%.pdf')"
    : excludePdf
      ? "NOT (LOWER(email_attachments.content_type) LIKE '%pdf%' OR LOWER(email_attachments.filename) LIKE '%.pdf')"
      : '1 = 1';
  const firstMail = isFirstMailReference(prompt);
  const orderDirection = firstMail ? 'ASC' : 'DESC';
  const orderBy = `ORDER BY email_messages.received_at ${orderDirection}, email_messages.id ${orderDirection}, email_attachments.id ${orderDirection}`;
  const attachmentId = extractAttachmentIdForRequest(prompt);
  const emailId = extractEmailIdForAttachment(prompt);
  const filenameHint = extractAttachmentFilenameHint(prompt);
  const folderHint = extractFolderHint(prompt);

  const clauses = [fileFilter];
  const params: unknown[] = [];

  if (attachmentId && Number.isFinite(attachmentId) && attachmentId > 0) {
    clauses.push('email_attachments.id = ?');
    params.push(attachmentId);
  }
  if (emailId && Number.isFinite(emailId) && emailId > 0) {
    clauses.push('email_messages.id = ?');
    params.push(emailId);
  }
  if (filenameHint) {
    clauses.push('LOWER(email_attachments.filename) LIKE ?');
    params.push(`%${filenameHint.toLowerCase()}%`);
  }
  if (folderHint) {
    clauses.push('(LOWER(folders.name) = ? OR LOWER(folders.path) LIKE ?)');
    params.push(folderHint, `%${folderHint}%`);
  }

  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = await dbAll(
    `SELECT
       email_attachments.id AS attachment_id,
       email_attachments.email_id AS email_id,
       email_attachments.filename AS filename,
       email_attachments.content_type AS content_type,
       email_attachments.storage_path AS storage_path,
       email_attachments.part AS part,
       folders.name AS folder_name,
       folders.path AS folder_path,
       email_messages.subject AS subject,
       email_messages.from_raw AS from_raw,
       email_messages.received_at AS received_at
     FROM email_attachments
     INNER JOIN email_messages ON email_attachments.email_id = email_messages.id
     INNER JOIN folders ON email_messages.folder_id = folders.id
     ${whereSql}
     ${orderBy}
     LIMIT 50;`,
    ...params,
  );

  return (rows || []).map((row) => ({
    attachment_id: Number(row?.attachment_id),
    email_id: Number(row?.email_id),
    filename: row?.filename ? String(row.filename) : null,
    content_type: row?.content_type ? String(row.content_type) : null,
    storage_path: row?.storage_path ? String(row.storage_path) : null,
    part: row?.part ? String(row.part) : null,
    folder_name: row?.folder_name ? String(row.folder_name) : null,
    folder_path: row?.folder_path ? String(row.folder_path) : null,
    subject: row?.subject ? String(row.subject) : null,
    from_raw: row?.from_raw ? String(row.from_raw) : null,
    received_at: row?.received_at ? String(row.received_at) : null,
  }));
}

async function loadOrExtractAttachmentText(
  dbGet: DbGet,
  dbRun: DbRun,
  attachment: AttachmentCandidate,
): Promise<string> {
  const existing = await dbGet(
    'SELECT extracted_text FROM attachment_text_extractions WHERE attachment_id = ? LIMIT 1;',
    attachment.attachment_id,
  );
  if (existing?.extracted_text && typeof existing.extracted_text === 'string') {
    return normalizeWhitespace(existing.extracted_text);
  }

  if (!attachment.storage_path) {
    throw new Error('Attachment file path is missing.');
  }
  const pdfBuffer = await loadAttachmentBufferFromStoragePath(attachment.storage_path);
  const extracted = await extractPdfTextFromBuffer(pdfBuffer);
  const finalText = normalizeWhitespace(extracted);
  await dbRun(
    `INSERT INTO attachment_text_extractions
      (attachment_id, email_id, folder_path, filename, content_type, extracted_text, text_length, extractor, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pdf2json', CURRENT_TIMESTAMP)
     ON CONFLICT(attachment_id) DO UPDATE SET
       email_id = excluded.email_id,
       folder_path = excluded.folder_path,
       filename = excluded.filename,
       content_type = excluded.content_type,
       extracted_text = excluded.extracted_text,
       text_length = excluded.text_length,
       extractor = excluded.extractor,
       updated_at = CURRENT_TIMESTAMP;`,
    attachment.attachment_id,
    attachment.email_id,
    attachment.folder_path,
    attachment.filename,
    attachment.content_type,
    finalText,
    finalText.length,
  );
  return finalText;
}

async function explainAttachmentText({
  dbGet,
  dbRun,
  prompt,
  attachment,
  extractedText,
}: {
  dbGet: DbGet;
  dbRun: DbRun;
  prompt: string;
  attachment: AttachmentCandidate;
  extractedText: string;
}): Promise<string> {
  const cacheKey = attachmentCacheKeyFor(attachment.attachment_id, prompt);
  const cached = await dbGet(
    'SELECT response FROM attachment_llm_cache WHERE key = ? LIMIT 1;',
    cacheKey,
  );
  if (cached?.response && typeof cached.response === 'string') {
    return cached.response;
  }

  const attachmentPrompt = buildAttachmentExplainPrompt({
    prompt,
    attachment,
    extractedText: trimAttachmentTextForPrompt(extractedText),
  });
  const raw = await sendToAssistant(attachmentPrompt, { model: 'qwen2.5-coder:14b' });
  if (!raw) {
    throw new Error('Assistant is unavailable for attachment explanation.');
  }
  const parsed = parseAttachmentExplain(raw);
  if (!parsed?.message || parsed.message.trim().length === 0) {
    throw new Error('Unable to parse attachment explanation response.');
  }

  const answer = parsed.message.trim();
  await dbRun(
    `INSERT INTO attachment_llm_cache
      (key, attachment_id, prompt, response, updated_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET
       attachment_id = excluded.attachment_id,
       prompt = excluded.prompt,
       response = excluded.response,
       updated_at = CURRENT_TIMESTAMP;`,
    cacheKey,
    attachment.attachment_id,
    prompt.trim(),
    answer,
  );
  return answer;
}

async function loadAttachmentDeliveryPayload(attachment: AttachmentCandidate): Promise<{
  attachment_id: number;
  email_id: number;
  filename: string | null;
  content_type: string | null;
  folder_path: string | null;
  data_base64: string;
}> {
  if (!attachment.storage_path) {
    throw new Error('Attachment file path is missing.');
  }
  const buffer = await loadAttachmentBufferFromStoragePath(attachment.storage_path);
  return {
    attachment_id: attachment.attachment_id,
    email_id: attachment.email_id,
    filename: attachment.filename,
    content_type: attachment.content_type,
    folder_path: attachment.folder_path,
    data_base64: buffer.toString('base64'),
  };
}

async function handleAttachmentIntent({
  dbAll,
  dbGet,
  dbRun,
  prompt,
  mode,
  sourceChannel,
}: {
  dbAll: DbAll;
  dbGet: DbGet;
  dbRun: DbRun;
  prompt: string;
  mode: 'read' | 'fetch';
  sourceChannel?: string;
}): Promise<LlmResponse> {
  const excludePdf = isNonPdfRequested(prompt);
  const requirePdf = (mode === 'read' || isPdfMentioned(prompt)) && !excludePdf;
  const candidate = await resolveAttachmentCandidate(dbAll, prompt, { requirePdf, excludePdf });
  if (!candidate) {
    if (isLastMailReference(prompt) && requirePdf) {
      return { success: false, type: 'message', message: 'No PDF attachment was found on the latest email.' };
    }
    return {
      success: false,
      type: 'message',
      message: requirePdf
        ? 'No matching PDF attachment was found.'
        : excludePdf
          ? 'No matching non-PDF attachment was found.'
          : 'No matching attachment was found.',
    };
  }
  if (!Number.isFinite(candidate.attachment_id) || candidate.attachment_id <= 0) {
    return { success: false, type: 'message', message: 'Attachment could not be resolved.' };
  }
  try {
    if (mode === 'fetch' && !shouldReturnBinaryAttachment(prompt)) {
      const candidates = isPluralAttachmentNamesRequest(prompt)
        ? await resolveAttachmentCandidates(dbAll, prompt, { requirePdf, excludePdf })
        : [candidate];
      if (!candidates || candidates.length === 0) {
        return { success: false, type: 'message', message: 'No matching attachments were found.' };
      }
      const names = candidates
        .map((item) => item.filename || `attachment #${item.attachment_id}`)
        .filter((name, idx, arr) => arr.indexOf(name) === idx)
        .slice(0, 50);
      const first = candidates[0];
      const responseRows = candidates.map((item) => ({
        attachment_id: item.attachment_id,
        email_id: item.email_id,
        filename: item.filename,
        folder_path: item.folder_path,
        content_type: item.content_type,
      }));
      const uiActions = buildUiActionsForAttachmentRows(Number(first.email_id), responseRows, sourceChannel);
      return {
        success: true,
        type: 'message',
        message: [
          `Found ${names.length} attachment name${names.length === 1 ? '' : 's'} for email ${first.email_id}:`,
          ...names.map((name) => `- ${name}`),
          'Binary delivery is only returned for: download, fetch, or display.',
          ...(!isWhatsappChannel(sourceChannel) ? renderInlineActions(uiActions) : []),
        ].join('\n'),
        rows: responseRows,
        ui_actions: uiActions,
      };
    }

    if (mode === 'fetch' && isPluralAttachmentNamesRequest(prompt)) {
      const candidates = await resolveAttachmentCandidates(dbAll, prompt, { requirePdf, excludePdf });
      if (!candidates || candidates.length === 0) {
        return { success: false, type: 'message', message: 'No matching attachments were found.' };
      }
      const names = candidates
        .map((item) => item.filename || `attachment #${item.attachment_id}`)
        .filter((name, idx, arr) => arr.indexOf(name) === idx)
        .slice(0, 50);
      const first = candidates[0];
      const responseRows = candidates.map((item) => ({
        attachment_id: item.attachment_id,
        email_id: item.email_id,
        filename: item.filename,
        folder_path: item.folder_path,
        content_type: item.content_type,
      }));
      const uiActions = buildUiActionsForAttachmentRows(Number(first.email_id), responseRows, sourceChannel);
      return {
        success: true,
        type: 'message',
        message: [
          `Found ${names.length} attachment name${names.length === 1 ? '' : 's'} for email ${first.email_id}:`,
          ...names.map((name) => `- ${name}`),
          ...(!isWhatsappChannel(sourceChannel) ? renderInlineActions(uiActions) : []),
        ].join('\n'),
        rows: responseRows,
        ui_actions: uiActions,
      };
    }

    if (mode === 'read') {
      if (!attachmentIsPdf(candidate)) {
        return {
          success: false,
          type: 'message',
          message: 'Reading attachments is currently supported only for PDF files.',
        };
      }
      const extractedText = await loadOrExtractAttachmentText(dbGet, dbRun, candidate);
      if (!extractedText || extractedText.trim().length === 0) {
        return {
          success: false,
          type: 'message',
          message: 'The PDF was processed, but no readable text was extracted.',
        };
      }
      const explanation = await explainAttachmentText({
        dbGet,
        dbRun,
        prompt,
        attachment: candidate,
        extractedText,
      });
      return {
        success: true,
        type: 'message',
        message: explanation,
        rows: [
          {
            attachment_id: candidate.attachment_id,
            email_id: candidate.email_id,
            filename: candidate.filename,
            folder_path: candidate.folder_path,
          },
        ],
      };
    }

    const payload = await loadAttachmentDeliveryPayload(candidate);
    // eslint-disable-next-line no-console
    console.log(
      `[orchestrator] sending attachment attachment_id=${payload.attachment_id} email_id=${payload.email_id} filename="${payload.filename || ''}" content_type="${payload.content_type || ''}" bytes_base64=${payload.data_base64.length}`,
    );
    return {
      ...(isWhatsappChannel(sourceChannel)
        ? {}
        : (() => {
            const attachmentUiActions = buildUiActionsForAttachmentRows(
              Number(candidate.email_id),
              [{ attachment_id: candidate.attachment_id }],
              sourceChannel,
            );
            return { ui_actions: attachmentUiActions };
          })()),
      success: true,
      type: 'attachment',
      message: [
        ...(() => {
          if (isWhatsappChannel(sourceChannel)) {
            return [formatEmailIdLabel(candidate.email_id, sourceChannel)];
          }
          const attachmentUiActions = buildUiActionsForAttachmentRows(
            Number(candidate.email_id),
            [{ attachment_id: candidate.attachment_id }],
            sourceChannel,
          );
          const { readInlineAction } = extractReadInlineAction(attachmentUiActions);
          return [
            readInlineAction
              ? `${formatEmailIdLabel(candidate.email_id, sourceChannel)} ${readInlineAction}`
              : formatEmailIdLabel(candidate.email_id, sourceChannel),
          ];
        })(),
        ...(isWhatsappChannel(sourceChannel)
          ? [`Read Link: ${buildReadEmailLink(candidate.email_id, sourceChannel)}`]
          : []),
        `From: ${candidate.from_raw || '(unknown sender)'}`,
        `Subject: ${candidate.subject || '(no subject)'}`,
        `Received: ${formatReceivedAtHuman(candidate.received_at)}`,
        `Attachment ready: ${candidate.filename || `#${candidate.attachment_id}`}`,
        ...(!isWhatsappChannel(sourceChannel)
          ? extractReadInlineAction(
              buildUiActionsForAttachmentRows(
                Number(candidate.email_id),
                [{ attachment_id: candidate.attachment_id }],
                sourceChannel,
              ),
            ).otherInlineActions
          : []),
      ].join('\n'),
      attachments: [payload],
      rows: [
        {
          attachment_id: candidate.attachment_id,
          email_id: candidate.email_id,
          filename: candidate.filename,
          folder_path: candidate.folder_path,
          content_type: candidate.content_type,
        },
      ],
    };
  } catch (err: any) {
    const reason = err?.message ? String(err.message) : 'Attachment processing failed.';
    return { success: false, type: 'message', message: reason };
  }
}

function normalizeSql(sql: string): string {
  return sql.trim().replace(/;+\s*$/, '');
}

function addOrderByBeforeLimit(sql: string, orderByClause: string): string {
  const normalized = normalizeSql(sql);
  const limitMatch = normalized.match(/\blimit\s+\d+(?:\s*,\s*\d+)?\s*$/i);
  if (!limitMatch || limitMatch.index === undefined) {
    return `${normalized} ${orderByClause}`.trim();
  }
  const beforeLimit = normalized.slice(0, limitMatch.index).trim();
  const limitPart = normalized.slice(limitMatch.index).trim();
  return `${beforeLimit} ${orderByClause} ${limitPart}`.trim();
}

function enforceLatestOrder(sql: string): string {
  const normalized = normalizeSql(sql);
  const lowered = normalized.toLowerCase();
  if (!/\bfrom\s+email_messages\b/i.test(lowered)) {
    return normalized;
  }
  const hasOrderBy = /\border\s+by\b/i.test(lowered);
  if (hasOrderBy) {
    return normalized.replace(
      /\border\s+by\b[\s\S]*?(?=(\blimit\b|$))/i,
      'ORDER BY email_messages.received_at DESC, email_messages.id DESC ',
    ).trim();
  }
  if (/\bwhere\b/i.test(lowered)) {
    const withFilter = normalized.replace(
      /\bwhere\b/i,
      'WHERE email_messages.received_at IS NOT NULL AND',
    );
    return addOrderByBeforeLimit(withFilter, 'ORDER BY email_messages.received_at DESC');
  }
  return addOrderByBeforeLimit(
    `${normalized} WHERE email_messages.received_at IS NOT NULL`,
    'ORDER BY email_messages.received_at DESC',
  );
}

function isExplicitLastOne(prompt: string): boolean {
  const lowered = prompt.toLowerCase();
  if (/\blast\s+\d+\b/.test(lowered)) {
    return false;
  }
  if (/\blast\s+\d+\s+email/.test(lowered)) {
    return false;
  }
  if (/\bfirst\s+\d+\s+(?:emails?|mails?|messages?)\b/.test(lowered)) {
    return false;
  }
  if (/\b(oldest|earliest)\b/.test(lowered)) {
    return false;
  }
  return /\b(last|latest|most recent|newest|first)\b/.test(lowered);
}

function shouldDefaultRecentFirst(prompt: string): boolean {
  const text = prompt.toLowerCase();
  const hasMail = /\b(mail|mails|email|emails|message|messages)\b/.test(text);
  const hasListIntent = /\b(show|list|display|view|fetch|get)\b/.test(text);
  if (!hasMail || !hasListIntent) {
    return false;
  }
  if (/\b(oldest|earliest|ascending|asc)\b/.test(text)) {
    return false;
  }
  return true;
}

function enforceDefaultRecentOrder(sql: string, prompt: string): string {
  const normalized = normalizeSql(sql);
  if (!shouldDefaultRecentFirst(prompt)) {
    return normalized;
  }
  if (!/\bfrom\s+email_messages\b/i.test(normalized)) {
    return normalized;
  }
  if (/\border\s+by\b/i.test(normalized)) {
    return normalized;
  }
  if (/\b(count|sum|min|max|avg)\s*\(/i.test(normalized)) {
    return normalized;
  }
  if (/\bgroup\s+by\b/i.test(normalized)) {
    return normalized;
  }
  if (/\bwhere\b/i.test(normalized)) {
    const withFilter = normalized.replace(
      /\bwhere\b/i,
      'WHERE email_messages.received_at IS NOT NULL AND',
    );
    return addOrderByBeforeLimit(withFilter, 'ORDER BY email_messages.received_at DESC');
  }
  return addOrderByBeforeLimit(
    `${normalized} WHERE email_messages.received_at IS NOT NULL`,
    'ORDER BY email_messages.received_at DESC',
  );
}

function extractRequestedEmailLimit(prompt: string): number | null {
  const text = prompt.toLowerCase();
  if (/\b(all|everything|all emails|all mail|all messages)\b/.test(text)) {
    return null;
  }
  if (
    /\b(last|latest|most\s+recent|newest|first|oldest|earliest)\s+(email|mail|message)\b/i.test(prompt) ||
    /\b(show|list|display|view|get|fetch|check)\b[\s\S]*\b(last|latest|most\s+recent|newest|first|oldest|earliest)\s+(email|mail|message)\b/i.test(
      prompt,
    )
  ) {
    return 1;
  }

  const patterns = [
    /\b(?:last|latest|first|top|recent|newest|oldest)\s+(\d{1,4})\s+(?:emails?|mails?|messages?)\b/i,
    /\bshow\s+me\s+(?:my\s+)?(\d{1,4})\s+(?:emails?|mails?|messages?)\b/i,
    /\b(\d{1,4})\s+(?:emails?|mails?|messages?)\b/i,
  ];
  for (const pattern of patterns) {
    const match = prompt.match(pattern);
    if (!match?.[1]) continue;
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value <= 0) continue;
    // Cap to a safe upper bound for operational stability.
    return Math.min(Math.floor(value), 500);
  }
  return null;
}

async function buildEmailViewerRows(dbAll: DbAll, rows: any[]): Promise<Array<{
  id: number;
  from_raw: string;
  to_raw: string;
  subject: string;
  received_at: string;
  folder: string;
  subfolder: string;
  body_text: string;
  body_html: string;
  attachments: string;
  attachment_ids: string;
  ai_summary: string;
  summary: string;
  summary_available: boolean;
}>> {
  if (!Array.isArray(rows) || rows.length === 0) {
    return [];
  }
  const ids = Array.from(
    new Set(
      rows
        .map((row) => Number(row?.id))
        .filter((id) => Number.isFinite(id) && id > 0)
        .map((id) => Math.floor(id)),
    ),
  );
  if (ids.length === 0) {
    return [];
  }
  const placeholders = ids.map(() => '?').join(', ');
  const detailRows = await dbAll(
    `SELECT email_messages.id AS id,
            email_messages.from_raw AS from_raw,
            email_messages.to_raw AS to_raw,
            email_messages.subject AS subject,
            email_messages.received_at AS received_at,
            email_messages.text_body AS text_body,
            email_messages.html_body AS body_html,
            email_llm_summaries.summary AS ai_summary,
            folders.name AS folder_name,
            folders.path AS folder_path,
            (SELECT GROUP_CONCAT(email_attachments.filename, ', ')
             FROM email_attachments
             WHERE email_attachments.email_id = email_messages.id) AS attachments,
            (SELECT GROUP_CONCAT(email_attachments.id, ', ')
             FROM email_attachments
             WHERE email_attachments.email_id = email_messages.id) AS attachment_ids
     FROM email_messages
     INNER JOIN folders ON folders.id = email_messages.folder_id
     LEFT JOIN email_llm_summaries ON email_llm_summaries.email_id = email_messages.id
     WHERE email_messages.id IN (${placeholders});`,
    ...ids,
  );
  const byId = new Map<number, any>();
  for (const row of detailRows || []) {
    const id = Number(row?.id);
    if (!Number.isFinite(id) || id <= 0) {
      continue;
    }
    byId.set(Math.floor(id), row);
  }
  const result: Array<{
    id: number;
    from_raw: string;
    to_raw: string;
    subject: string;
    received_at: string;
    folder: string;
    subfolder: string;
    body_text: string;
    body_html: string;
    attachments: string;
    attachment_ids: string;
    ai_summary: string;
    summary: string;
    summary_available: boolean;
  }> = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) {
      continue;
    }
    const folderPath = typeof row.folder_path === 'string' ? row.folder_path : '';
    const folderParts = splitFolderPath(folderPath);
    result.push({
      id,
      from_raw: typeof row.from_raw === 'string' ? row.from_raw : '',
      to_raw: typeof row.to_raw === 'string' ? row.to_raw : '',
      subject: typeof row.subject === 'string' ? row.subject : '',
      received_at: typeof row.received_at === 'string' ? row.received_at : '',
      folder: (typeof row.folder_name === 'string' ? row.folder_name : folderParts.folder) || '',
      subfolder: folderParts.subfolder || '',
      body_text: typeof row.text_body === 'string' ? row.text_body : '',
      body_html: typeof row.body_html === 'string' ? row.body_html : '',
      attachments: typeof row.attachments === 'string' ? row.attachments : '',
      attachment_ids: typeof row.attachment_ids === 'string' ? row.attachment_ids : '',
      ai_summary:
        typeof row.ai_summary === 'string' && !isInvalidSummaryText(row.ai_summary) ? row.ai_summary : '',
      summary:
        typeof row.ai_summary === 'string' && !isInvalidSummaryText(row.ai_summary) ? row.ai_summary : '',
      summary_available:
        typeof row.ai_summary === 'string' && row.ai_summary.trim().length > 0 && !isInvalidSummaryText(row.ai_summary),
    });
  }
  return result;
}

function isSimpleListEmailsPrompt(prompt: string): boolean {
  const text = prompt.toLowerCase();
  const hasMail = /\b(mail|mails|email|emails|message|messages|inbox)\b/.test(text);
  if (!hasMail) {
    return false;
  }
  const hasCountIntent = /\b(how\s+many|count|number\s+of)\b/.test(text);
  if (hasCountIntent) {
    return false;
  }
  const hasPossessiveList = /\bmy\s+(mail|mails|email|emails|inbox)\b/.test(text);
  const hasListShape =
    /\b(show|list|display|check|view|get)\b/.test(text) ||
    /\b(last|latest|recent|newest|oldest|first)\b/.test(text) ||
    hasPossessiveList;
  if (!hasListShape) {
    return false;
  }
  const hasNonListAction =
    /\b(reply|respond|send|forward|delete|remove|move|archive|download|attachment|attachments|pdf|mark|unread|read\s+email)\b/.test(
      text,
    );
  if (hasNonListAction) {
    return false;
  }
  return true;
}

function isTodayMyMailsPrompt(prompt: string): boolean {
  const text = String(prompt || '').toLowerCase().trim().replace(/\s+/g, ' ');
  if (/^my (mails?|emails?)$/.test(text)) {
    return true;
  }
  return /^(show|list|display|view|check) (?:me )?(?:my )?(mails?|emails?)$/.test(text);
}

function isCountMailRequest(prompt: string): boolean {
  const text = prompt.toLowerCase();
  const hasCount = /\b(how\s+many|count|number\s+of)\b/.test(text);
  const hasMail = /\b(mail|mails|email|emails|message|messages)\b/.test(text);
  return hasCount && hasMail;
}

function extractEmailSearchTerm(prompt: string): string | null {
  const raw = String(prompt || '').trim();
  if (!raw) {
    return null;
  }
  const quoted = raw.match(/"([^"]{2,})"/);
  if (quoted?.[1]) {
    return quoted[1].trim();
  }
  const lower = raw.toLowerCase();
  const fromMatch = lower.match(/\bfrom\s+([a-z0-9._%+\-@]+)\b/i);
  if (fromMatch?.[1]) {
    return fromMatch[1].trim();
  }
  const markerMatch = lower.match(/\b(?:for|about|containing|contains|matching|match)\s+(.+)$/i);
  if (markerMatch?.[1]) {
    return markerMatch[1].trim();
  }
  const searchPrefix = lower.match(/\b(?:search|find|lookup|look\s+for)\b\s+(.+)$/i);
  if (searchPrefix?.[1]) {
    return searchPrefix[1].trim();
  }
  return null;
}

function isExplicitEmailSearchPrompt(prompt: string): boolean {
  const text = String(prompt || '').toLowerCase();
  const hasMail = /\b(mail|mails|email|emails|message|messages|inbox)\b/.test(text);
  if (!hasMail) {
    return false;
  }
  const hasSearchIntent =
    /\b(search|find|lookup|look\s+for)\b/.test(text) ||
    /\b(containing|contains|matching|match|about)\b/.test(text) ||
    /\bfrom\s+[a-z0-9._%+\-@]{3,}\b/.test(text);
  if (!hasSearchIntent) {
    return false;
  }
  return Boolean(extractEmailSearchTerm(prompt));
}

function wantsAllResults(prompt: string): boolean {
  const text = prompt.toLowerCase();
  return /\b(all|everything|all emails|all mail|all messages)\b/.test(text);
}

function removeLimitClause(sql: string): string {
  return normalizeSql(sql).replace(/\s+\blimit\s+\d+(?:\s*,\s*\d+)?(?:\s+offset\s+\d+)?\b/gi, '');
}

function extractSenderFilterTerm(prompt: string): string | null {
  const match = prompt.match(/\bfrom\s+([a-z0-9._%+\-@]+)/i);
  if (!match?.[1]) {
    return null;
  }
  const term = match[1].trim().toLowerCase();
  const nonSenderTerms = new Set([
    'today',
    'yesterday',
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
    'sunday',
    'mon',
    'tue',
    'wed',
    'thu',
    'fri',
    'sat',
    'sun',
    'last',
    'this',
  ]);
  if (nonSenderTerms.has(term)) {
    return null;
  }
  if (term.length < 3) {
    return null;
  }
  return term;
}

function extractWeekdayDateRange(prompt: string): { startIso: string; endIso: string } | null {
  const text = String(prompt || '').toLowerCase();
  if (!text) {
    return null;
  }
  const weekdayMap: Record<string, number> = {
    sunday: 0,
    sun: 0,
    monday: 1,
    mon: 1,
    tuesday: 2,
    tue: 2,
    wednesday: 3,
    wed: 3,
    thursday: 4,
    thu: 4,
    friday: 5,
    fri: 5,
    saturday: 6,
    sat: 6,
  };
  const explicitToday = /\b(today)\b/.test(text);
  const explicitYesterday = /\b(yesterday)\b/.test(text);
  if (explicitToday || explicitYesterday) {
    const now = new Date();
    const offset = explicitYesterday ? -1 : 0;
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, 0, 0, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset + 1, 0, 0, 0, 0);
    return { startIso: start.toISOString(), endIso: end.toISOString() };
  }
  const weekdayMatch = text.match(/\b(?:from|on|for)?\s*(last\s+)?(monday|mon|tuesday|tue|wednesday|wed|thursday|thu|friday|fri|saturday|sat|sunday|sun)\b/i);
  if (!weekdayMatch?.[2]) {
    return null;
  }
  const target = weekdayMap[weekdayMatch[2].toLowerCase()];
  if (!Number.isFinite(target)) {
    return null;
  }
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const currentDow = today.getDay();
  let delta = (currentDow - target + 7) % 7;
  const hasLast = Boolean(weekdayMatch[1] && weekdayMatch[1].trim().length > 0);
  if (delta === 0 && hasLast) {
    delta = 7;
  }
  const start = new Date(today);
  start.setDate(today.getDate() - delta);
  const end = new Date(start);
  end.setDate(start.getDate() + 1);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

function promptHasExplicitFolderConstraint(prompt: string): boolean {
  const text = prompt.toLowerCase();
  return /\b(inbox|sent|trash|spam|junk|archive|archived|folder)\b/.test(text);
}

async function maybeExpandSenderScopedRows(
  dbAll: DbAll,
  prompt: string,
  requestedLimit: number | null,
  wantsAll: boolean,
  currentRows: any[],
): Promise<{ rows: any[]; sql?: string }> {
  const senderTerm = extractSenderFilterTerm(prompt);
  if (!senderTerm) {
    return { rows: currentRows };
  }
  if (promptHasExplicitFolderConstraint(prompt)) {
    return { rows: currentRows };
  }
  if (!wantsAll && (!requestedLimit || requestedLimit <= 1)) {
    // Even without explicit LIMIT, sender-scoped prompts must be constrained by sender.
    // Continue to sender fallback query.
  } else if (!wantsAll && Array.isArray(currentRows) && currentRows.length >= (requestedLimit || 0)) {
    return { rows: currentRows };
  }
  const safeLimit = requestedLimit && requestedLimit > 0 ? requestedLimit : 10;
  const fallbackLimitSql =
    `SELECT email_messages.id, email_messages.from_raw, email_messages.subject, email_messages.received_at, ` +
    `(SELECT GROUP_CONCAT(filename, ', ') FROM email_attachments WHERE email_attachments.email_id = email_messages.id) AS attachments ` +
    `FROM email_messages ` +
    `WHERE LOWER(COALESCE(email_messages.from_raw, '')) LIKE ? ` +
    `AND email_messages.received_at IS NOT NULL ` +
    `ORDER BY email_messages.received_at DESC, email_messages.id DESC ` +
    `LIMIT ${safeLimit}`;
  const fallbackAllSql =
    `SELECT email_messages.id, email_messages.from_raw, email_messages.subject, email_messages.received_at, ` +
    `(SELECT GROUP_CONCAT(filename, ', ') FROM email_attachments WHERE email_attachments.email_id = email_messages.id) AS attachments ` +
    `FROM email_messages ` +
    `WHERE LOWER(COALESCE(email_messages.from_raw, '')) LIKE ? ` +
    `AND email_messages.received_at IS NOT NULL ` +
    `ORDER BY email_messages.received_at DESC, email_messages.id DESC`;
  const fallbackSql = wantsAll ? fallbackAllSql : fallbackLimitSql;
  const fallbackRows = await dbAll(fallbackSql, `%${senderTerm}%`);
  // Sender-scoped prompts must return sender-scoped results only.
  // Always prefer the sender-filtered fallback, even when it returns fewer rows.
  return { rows: fallbackRows, sql: fallbackSql };
}

function applyRequestedLimit(sql: string, requestedLimit: number | null): string {
  if (!requestedLimit || requestedLimit <= 0) {
    return sql;
  }
  const normalized = normalizeSql(sql);
  if (/\blimit\s+\d+(?:\s*,\s*\d+)?(?:\s+offset\s+\d+)?\b/i.test(normalized)) {
    return normalized.replace(
      /\blimit\s+\d+(?:\s*,\s*\d+)?(?:\s+offset\s+\d+)?\b/i,
      `LIMIT ${requestedLimit}`,
    );
  }
  return `${normalized} LIMIT ${requestedLimit}`;
}

async function sendToAssistant(
  input:
    | ReturnType<typeof buildLearningExtractPrompt>
    | ReturnType<typeof buildLearningsSqlPrompt>
    | ReturnType<typeof buildEmailSqlPrompt>
    | ReturnType<typeof buildReplyExtractPrompt>
    | ReturnType<typeof buildReplyBodyDerivePrompt>
    | ReturnType<typeof buildEmailReadSummaryPrompt>
    | ReturnType<typeof buildAttachmentExplainPrompt>,
  options?: { model?: string },
): Promise<string | null> {
  const rawUrl = process.env.ASSISTANT_URL ?? '';
  const token = (process.env.ASSISTANT_AUTH ?? process.env.AUTH ?? '').trim();
  const rawToken = token.replace(/^Bearer\s+/i, '').trim();
  const authorizationHeader = rawToken === '' ? '' : `Bearer ${rawToken}`;
  const authHeaderInfo = authorizationHeader
    ? `${authorizationHeader.split(/\s+/, 1)[0]} (len=${authorizationHeader.length})`
    : 'missing';

  if (rawUrl.trim() === '') {
    // eslint-disable-next-line no-console
    console.log('Assistant call skipped: missing ASSISTANT_URL');
  return null;
}

  const url = rawUrl.match(/^https?:\/\//i) ? rawUrl : `http://${rawUrl}`;

  const messagePayload: Record<string, unknown> = {
    Authorization: rawToken,
    authorization: rawToken,
    model: options?.model ?? process.env.ASSISTANT_MODEL ?? 'qwen2.5:14b',
    messages: [
      { role: 'system', content: input.system.trim() },
      { role: 'user', content: input.user },
    ],
    temperature: 0.2,
    stream: false,
    format: 'json',
  };

  const body = {
    from: 'custom-prompt',
    message: JSON.stringify(messagePayload),
  };

  // eslint-disable-next-line no-console
  console.log('Assistant payload ->', JSON.stringify(body));
  // eslint-disable-next-line no-console
  console.log('Assistant ->', url);
  // eslint-disable-next-line no-console
  console.log('Assistant auth header ->', authHeaderInfo);
  const controller = new AbortController();
  const timeoutMs =
    Number.isFinite(ASSISTANT_TIMEOUT_MS) && ASSISTANT_TIMEOUT_MS > 0 ? ASSISTANT_TIMEOUT_MS : 300000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(authorizationHeader ? { Authorization: authorizationHeader } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      // eslint-disable-next-line no-console
      console.log('Assistant call timed out', timeoutMs);
      return null;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  // eslint-disable-next-line no-console
  console.log('Assistant <- status', response.status);
  if (!response.ok) {
    // eslint-disable-next-line no-console
    console.log('Assistant call failed', response.status);
  }
  const raw = await response.text();
  // eslint-disable-next-line no-console
  console.log('Assistant <-', raw);
  return raw;
}

async function getCachedEmailSummary(dbGet: DbGet, emailId: number): Promise<string | null> {
  const row = await dbGet(
    'SELECT summary FROM email_llm_summaries WHERE email_id = ? LIMIT 1;',
    emailId,
  );
  const summary = row?.summary ? String(row.summary).trim() : '';
  return summary || null;
}

async function saveEmailSummaryCache(
  dbRun: DbRun,
  emailId: number,
  summary: string,
  model: string,
  rawResponse: string,
): Promise<void> {
  await dbRun(
    `INSERT INTO email_llm_summaries (email_id, summary, model, raw_response, updated_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(email_id) DO UPDATE SET
       summary = excluded.summary,
       model = excluded.model,
       raw_response = excluded.raw_response,
       updated_at = CURRENT_TIMESTAMP;`,
    emailId,
    summary,
    model,
    rawResponse,
  );
}

function cacheKeyFor(prompt: string, result?: string): string {
  return `${prompt}||${result ?? ''}`.trim();
}

function shouldBypassSqlCache(prompt: string): boolean {
  const text = prompt.toLowerCase();
  const hasAttachmentConstraint =
    /\battachment|attachments|pdf|non[-\s]?pdf|not\s+pdf\b/.test(text) ||
    (/\b(first|oldest|latest|last)\b/.test(text) && /\battachment|pdf\b/.test(text));
  const hasRelativeRecencyRequest =
    /\b(last|latest|most\s+recent|newest|first)\b/.test(text) &&
    /\b(mail|email|message|sent)\b/.test(text);
  const hasSenderScopedRequest =
    /\bfrom\s+[a-z0-9._%+\-@]{2,}\b/.test(text) &&
    /\b(mail|email|message|sent|inbox)\b/.test(text);
  return hasAttachmentConstraint || hasRelativeRecencyRequest || hasSenderScopedRequest;
}

export function createLlmHandler({
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
}: {
  dbAll: DbAll;
  dbGet: DbGet;
  dbRun: DbRun;
  syncMail?: () => Promise<void>;
  sendMail?: (payload: SendMailPayload) => Promise<SendMailResult>;
  deleteMail?: (payload: { ids: number[] }) => Promise<DeleteMailResult>;
  moveMail?: (payload: { ids: number[]; folder: string }) => Promise<MoveMailResult>;
  markAsRead?: (payload: { all?: boolean; ids?: number[]; folder?: string; limit?: number }) => Promise<MarkReadResult>;
  deleteTrash?: () => Promise<DeleteTrashResult>;
  deleteFolder?: (payload: { name: string }) => Promise<DeleteFolderResult>;
}) {
  return async function handleLlmRequest(payload: unknown): Promise<LlmResponse> {
    // eslint-disable-next-line no-console
    console.log('LLM request payload <-', JSON.stringify(payload));
    const prompt =
      typeof (payload as { prompt?: unknown })?.prompt === 'string'
        ? String((payload as { prompt?: unknown }).prompt)
        : '';
    const result =
      typeof (payload as { result?: unknown })?.result === 'string'
        ? String((payload as { result?: unknown }).result)
        : undefined;
    const sourceChannel =
      typeof (payload as { source_channel?: unknown })?.source_channel === 'string'
        ? String((payload as { source_channel?: unknown }).source_channel)
        : undefined;
    const sourceFrom =
      typeof (payload as { source_from?: unknown })?.source_from === 'string'
        ? String((payload as { source_from?: unknown }).source_from)
        : undefined;
    const skipConfirmation = extractSkipConfirmation(payload);
    const followUpHint = extractFollowUpHint(payload);
    const skipCacheHint = parseBooleanLike((payload as { skip_cache?: unknown })?.skip_cache);

    if (!prompt) {
      return { success: false, message: 'Prompt is required.' };
    }

    const cacheRemovalTarget = extractEmailCacheRemovalTarget(prompt);
    const skipSqlCacheForRequest = cacheRemovalTarget !== null;
    if (cacheRemovalTarget !== null) {
      if (!cacheRemovalTarget) {
        return {
          success: false,
          message: 'Please provide the exact cache key after "remove from my email cache".',
        };
      }
      const sqlCacheRows = await dbAll(
        'SELECT key FROM llm_sql_cache WHERE key = ? OR key LIKE ?;',
        cacheRemovalTarget,
        `${cacheRemovalTarget}||%`,
      );
      const attachmentCacheRows = await dbAll(
        'SELECT key FROM attachment_llm_cache WHERE LOWER(prompt) = LOWER(?);',
        cacheRemovalTarget,
      );
      if (sqlCacheRows.length === 0 && attachmentCacheRows.length === 0) {
        return {
          success: false,
          message: `No email cache entries found for: ${cacheRemovalTarget}`,
        };
      }
      for (const row of sqlCacheRows) {
        await dbRun('DELETE FROM llm_sql_cache WHERE key = ?;', String(row.key));
      }
      for (const row of attachmentCacheRows) {
        await dbRun('DELETE FROM attachment_llm_cache WHERE key = ?;', String(row.key));
      }
      return {
        success: true,
        message: `Removed email cache entries for: ${cacheRemovalTarget} (sql_cache=${sqlCacheRows.length}, attachment_cache=${attachmentCacheRows.length})`,
      };
    }

    const requestPayload: LlmPayload = {
      prompt,
      result,
      source_channel: sourceChannel,
      source_from: sourceFrom,
      skip_cache: skipCacheHint,
    };
    const followUpContext = await loadFollowUpContext(dbGet, dbAll);
    const hasFollowUpContext = followUpContext.length > 0;
    if (EMAIL_DISABLE_FOLLOW_UP_QUESTIONS && hasFollowUpContext) {
      await resetFollowUpContext(dbRun);
    } else if (hasFollowUpContext) {
      requestPayload.follow_up_context = followUpContext;
    }
    const hasReplyFollowUpContext = followUpContext.some((turn) =>
      /\breply|respond\b/i.test(turn.llm_reply || ''),
    );
    await refreshLearnings();

    if (isMailSyncRequest(prompt)) {
      if (!syncMail) {
        return { success: false, message: 'Mail sync is not available.' };
      }
      try {
        const before = await loadFolderCounts(dbAll);
        const syncResult = await runWithSoftTimeout(() => syncMail(), MAIL_SYNC_LLM_TIMEOUT_MS);
        if (syncResult.status === 'failed') {
          return { success: false, message: `Mail sync failed: ${syncResult.error}` };
        }
        if (syncResult.status === 'timed_out') {
          const seconds = Math.max(1, Math.round(MAIL_SYNC_LLM_TIMEOUT_MS / 1000));
          return {
            success: true,
            message: `Mail sync started and is still running. It exceeded ${seconds}s; try "check emails" again shortly.`,
          };
        }
        const after = await loadFolderCounts(dbAll);
        return { success: true, message: buildSyncSummary(before, after) };
      } catch (err: any) {
        return { success: false, message: `Mail sync failed: ${toErrorMessage(err)}` };
      }
    }
    if (isSendMailRequest(prompt)) {
      if (!sendMail) {
        return { success: false, message: 'Mail sending is not available.' };
      }
      const fields = extractSendMailFields(prompt);
      if (!fields) {
        return {
          success: false,
          message: 'Please provide recipient, subject, and body.',
        };
      }
      try {
        const result = await sendMail(fields);
        const accepted = result.accepted?.length ?? 0;
        const rejected = result.rejected?.length ?? 0;
        const parts: string[] = [];
        if (accepted > 0) {
          parts.push(`Email sent to ${fields.to}.`);
        } else {
          parts.push('Email send failed.');
        }
        if (accepted > 0 || rejected > 0) {
          parts.push(`Accepted: ${accepted}, Rejected: ${rejected}.`);
        }
        if (result.messageId) {
          parts.push(`Message ID: ${result.messageId}.`);
        } else if (result.response) {
          parts.push(`Response: ${result.response}.`);
        }
        return { success: accepted > 0, message: parts.join(' ') };
      } catch (err: any) {
        const reason = err?.message ? String(err.message) : 'Unknown error';
        return { success: false, message: `Email send failed: ${reason}` };
      }
    }

    if (isReadMailRequest(prompt)) {
      try {
        const resolvedId = await resolveReadMailTargetId(dbGet, prompt);
        if (!resolvedId) {
          return { success: false, type: 'message', message: 'Please provide an email id or a clear latest/oldest reference to read.' };
        }
        const emailId = resolvedId;
        const row = await dbGet(
          `SELECT email_messages.id as id,
                  email_messages.from_raw as from_raw,
                  email_messages.to_raw as to_raw,
                  email_messages.cc_raw as cc_raw,
                  email_messages.bcc_raw as bcc_raw,
                  email_messages.subject as subject,
                  email_messages.received_at as received_at,
                  email_messages.text_body as text_body,
                  email_messages.html_body as html_body,
                  folders.name as folder_name,
                  folders.path as folder_path
           FROM email_messages
           INNER JOIN folders ON email_messages.folder_id = folders.id
           WHERE email_messages.id = ?
           LIMIT 1;`,
          emailId,
        );
        if (!row?.id) {
          return { success: false, type: 'message', message: `Email ${emailId} was not found.` };
        }
        const attachmentRows = await dbAll(
          `SELECT id, email_id, part, filename, content_type, size, storage_path
           FROM email_attachments
           WHERE email_id = ?
           ORDER BY id ASC;`,
          emailId,
        );
        const attachments = attachmentRows
          .map((attachment) => ({
            id: Number(attachment?.id),
            email_id: Number(attachment?.email_id),
            part: attachment?.part ? String(attachment.part) : null,
            filename: attachment?.filename ? String(attachment.filename) : null,
            content_type: attachment?.content_type ? String(attachment.content_type) : null,
            size: Number.isFinite(Number(attachment?.size)) ? Number(attachment.size) : null,
            storage_path: attachment?.storage_path ? String(attachment.storage_path) : null,
          }))
          .filter((attachment) => Number.isFinite(attachment.id) && attachment.id > 0);

      const pdfExtractions: Array<{ attachment_id: number; filename: string | null; extracted_text: string }> = [];
      for (const attachment of attachments) {
        const candidate: AttachmentCandidate = {
          attachment_id: attachment.id,
          email_id: emailId,
          filename: attachment.filename,
          content_type: attachment.content_type,
          storage_path: attachment.storage_path,
          part: attachment.part,
          folder_name: row?.folder_name ? String(row.folder_name) : null,
          folder_path: row?.folder_path ? String(row.folder_path) : null,
          subject: row?.subject ? String(row.subject) : null,
          from_raw: row?.from_raw ? String(row.from_raw) : null,
          received_at: row?.received_at ? String(row.received_at) : null,
        };
        if (!attachmentIsPdf(candidate)) {
          continue;
        }
        try {
          const extractedText = await loadOrExtractAttachmentText(dbGet, dbRun, candidate);
          if (extractedText && extractedText.trim().length > 0) {
            pdfExtractions.push({
              attachment_id: attachment.id,
              filename: attachment.filename,
              extracted_text: trimAttachmentTextForPrompt(extractedText),
            });
          }
        } catch {
          // Ignore single attachment extraction failures and continue.
        }
      }

      const folderParts = splitFolderPath(row?.folder_path);
      const normalizedHtmlBody =
        typeof row?.html_body === 'string' && row.html_body.trim().length > 0
          ? String(row.html_body)
          : '';
      const normalizedBody =
        typeof row?.text_body === 'string' && row.text_body.trim().length > 0
          ? normalizeWhitespace(String(row.text_body))
          : '';
      let summaryText = await getCachedEmailSummary(dbGet, emailId);
      if (summaryText && isInvalidSummaryText(summaryText)) {
        summaryText = '';
      }
      const wantsSummary = isSummaryMailRequest(prompt);
      if (!summaryText || wantsSummary) {
        try {
          const summaryPrompt = buildEmailReadSummaryPrompt({
            prompt,
            email: {
              id: emailId,
              from_raw: row?.from_raw ? String(row.from_raw) : null,
              to_raw: row?.to_raw ? String(row.to_raw) : null,
              cc_raw: row?.cc_raw ? String(row.cc_raw) : null,
              bcc_raw: row?.bcc_raw ? String(row.bcc_raw) : null,
              subject: row?.subject ? String(row.subject) : null,
              received_at: row?.received_at ? String(row.received_at) : null,
              folder: row?.folder_name ? String(row.folder_name) : folderParts.folder,
              subfolder: folderParts.subfolder,
              text_body: normalizedBody || null,
              html_body: normalizedHtmlBody || null,
            },
            attachments: attachments.map((attachment) => ({
              id: Number(attachment.id || 0),
              filename: attachment.filename || null,
              content_type: attachment.content_type || null,
              size: attachment.size ?? null,
            })),
            pdf_extractions: pdfExtractions,
          });
          const summaryRaw = await sendToAssistant(summaryPrompt, { model: 'qwen2.5-coder:14b' });
          const parsedSummary = summaryRaw ? parseEmailReadSummary(summaryRaw) : null;
          const generatedSummary =
            parsedSummary && typeof parsedSummary.ai_summary === 'string'
              ? parsedSummary.ai_summary.trim()
              : '';
          if (generatedSummary && !isInvalidSummaryText(generatedSummary)) {
            summaryText = generatedSummary;
            await saveEmailSummaryCache(dbRun, emailId, generatedSummary, 'qwen2.5-coder:14b', summaryRaw || '');
          } else if (!summaryText) {
            summaryText = '';
          }
        } catch (err: any) {
          // eslint-disable-next-line no-console
          console.log('Email summary generation failed for read request ->', err?.message || String(err));
          if (!summaryText) {
            summaryText = '';
          }
        }
      }
      const structuredPayload = {
        email_id: Number(row.id),
        from: row?.from_raw ? String(row.from_raw) : '',
        to: row?.to_raw ? String(row.to_raw) : '',
        subject: row?.subject ? String(row.subject) : '',
        received_at: row?.received_at ? String(row.received_at) : '',
        folder: row?.folder_name ? String(row.folder_name) : folderParts.folder,
        subfolder: folderParts.subfolder,
        body_text: normalizedBody,
        body_html: normalizedHtmlBody,
        ai_summary: summaryText || '',
        summary_available: Boolean(summaryText && summaryText.trim().length > 0),
        email: {
          id: Number(row.id),
          from_raw: row?.from_raw ? String(row.from_raw) : null,
          to_raw: row?.to_raw ? String(row.to_raw) : null,
          subject: row?.subject ? String(row.subject) : null,
          received_at: row?.received_at ? String(row.received_at) : null,
          body: normalizedHtmlBody || normalizedBody || '(no body)',
        },
        attachment_details: attachments.map((attachment) => ({
          id: Number(attachment.id || 0),
          filename: attachment.filename || null,
          content_type: attachment.content_type || null,
        })),
        summary: summaryText || '',
        pdf_sections: pdfExtractions,
      };
      const attachmentSummary =
        structuredPayload.attachment_details.length === 0
          ? 'no'
          : structuredPayload.attachment_details
              .map((attachment) => {
                const name = attachment.filename || '(unnamed)';
                const contentType = attachment.content_type || 'unknown';
                return `${attachment.id}: ${name} (${contentType})`;
              })
              .join(', ');
      const isWhatsapp = String(sourceChannel || '').trim().toLowerCase() === 'whatsapp';
      const summaryUiActions = buildUiActionsForAttachmentRows(
        structuredPayload.email.id,
        structuredPayload.attachment_details.map((item) => ({ attachment_id: item.id })),
        sourceChannel,
      );
      const { readInlineAction: summaryReadInlineAction, otherInlineActions: summaryOtherInlineActions } = !isWhatsapp
        ? extractReadInlineAction(summaryUiActions)
        : { readInlineAction: undefined, otherInlineActions: [] };
      const summaryIdLine = !isWhatsapp && summaryReadInlineAction
        ? `${formatEmailIdLabel(structuredPayload.email.id, sourceChannel)} ${summaryReadInlineAction}`
        : formatEmailIdLabel(structuredPayload.email.id, sourceChannel);
      const pdfSummary =
        structuredPayload.pdf_sections.length === 0
          ? 'none'
          : structuredPayload.pdf_sections
              .map((section) => `${section.attachment_id}:${section.filename || '(unnamed)'}`)
              .join(', ');
      const summaryOutputMessage = isWhatsapp
        ? [
            `Summary: ${structuredPayload.summary}`,
            '',
            '',
            summaryIdLine,
            `Read Link: ${buildReadEmailLink(structuredPayload.email.id, sourceChannel)}`,
            `From: ${structuredPayload.email.from_raw || '(unknown sender)'}`,
            `Subject: ${structuredPayload.email.subject || '(no subject)'}`,
            `Received: ${formatReceivedAtHuman(structuredPayload.email.received_at)}`,
            `Attachments: ${attachmentSummary === 'no' ? 'no' : 'yes'}`,
            ...(attachmentSummary !== 'no'
              ? [`Attachments Link: ${buildShowAttachmentsLink(structuredPayload.email.id, sourceChannel)}`]
              : []),
            `Body: ${structuredPayload.email.body}`,
            `PDF Sections: ${pdfSummary}`,
          ].join('\n')
        : [
            '<article class="email-read-card">',
            `<p><strong>Summary:</strong> ${escapeHtml(structuredPayload.summary)}</p>`,
            `<p><strong>${escapeHtml(summaryIdLine)}</strong></p>`,
            `<p><strong>From:</strong> ${escapeHtml(structuredPayload.email.from_raw || '(unknown sender)')}</p>`,
            `<p><strong>Subject:</strong> ${escapeHtml(structuredPayload.email.subject || '(no subject)')}</p>`,
            `<p><strong>Received:</strong> ${escapeHtml(formatReceivedAtHuman(structuredPayload.email.received_at))}</p>`,
            `<p><strong>Attachments:</strong> ${escapeHtml(attachmentSummary)}</p>`,
            ...summaryOtherInlineActions.map((line) => `<p>${escapeHtml(line)}</p>`),
            '<div><strong>Body:</strong></div>',
            `<div>${renderEmailBodyAsHtml(structuredPayload.email.body)}</div>`,
            `<p><strong>PDF Sections:</strong> ${escapeHtml(pdfSummary)}</p>`,
            '</article>',
          ].join('\n');
        return {
          success: true,
          type: 'message',
          message: summaryOutputMessage,
          email: structuredPayload.email,
          email_id: structuredPayload.email_id,
          from: structuredPayload.from,
          to: structuredPayload.to,
          subject: structuredPayload.subject,
          received_at: structuredPayload.received_at,
          folder: structuredPayload.folder,
          subfolder: structuredPayload.subfolder,
          body_text: structuredPayload.body_text,
          body_html: structuredPayload.body_html,
          ai_summary: structuredPayload.ai_summary,
          summary_available: structuredPayload.summary_available,
          attachment_details: structuredPayload.attachment_details,
          summary: structuredPayload.summary,
          pdf_sections: structuredPayload.pdf_sections,
          ui_actions: summaryUiActions,
        };
      } catch (err: any) {
        // eslint-disable-next-line no-console
        console.log('Read email flow failed ->', err?.message || String(err));
        return {
          success: false,
          type: 'message',
          message: 'Unable to read this email right now. Please try again shortly.',
        };
      }
    }

    if (isShowAttachmentsForEmailRequest(prompt)) {
      const emailId = extractEmailIdForAttachment(prompt);
      if (!emailId) {
        return { success: false, type: 'message', message: 'Please provide a valid email id.' };
      }
      const emailRow = await dbGet(
        `SELECT id, from_raw, subject, received_at
         FROM email_messages
         WHERE id = ?
         LIMIT 1;`,
        emailId,
      );
      if (!emailRow?.id) {
        return { success: false, type: 'message', message: `Email ${emailId} was not found.` };
      }
      const attachmentRows = await dbAll(
        `SELECT id, filename, content_type, size
         FROM email_attachments
         WHERE email_id = ?
         ORDER BY id ASC;`,
        emailId,
      );
      const hasAttachments = attachmentRows.length > 0;
      const attachmentLines = hasAttachments
        ? attachmentRows.map((row) => {
            const id = Number(row?.id);
            const filename = row?.filename ? String(row.filename) : '(unnamed)';
            const contentType = row?.content_type ? String(row.content_type) : 'unknown';
            const downloadLink = buildDownloadAttachmentLink(id, sourceChannel);
            return `- ${id}: ${filename} (${contentType}) | Download Link: ${downloadLink}`;
          })
        : [];
      const isWhatsapp = isWhatsappChannel(sourceChannel);
      const responseRows = attachmentRows.map((row) => ({
        email_id: emailId,
        attachment_id: Number(row?.id),
        filename: row?.filename ? String(row.filename) : null,
        content_type: row?.content_type ? String(row.content_type) : null,
        size: Number(row?.size || 0),
      }));
      const attachmentUiActions = buildUiActionsForAttachmentRows(emailId, responseRows, sourceChannel);
      const { readInlineAction: attachmentReadInlineAction, otherInlineActions: attachmentOtherInlineActions } = !isWhatsapp
        ? extractReadInlineAction(attachmentUiActions)
        : { readInlineAction: undefined, otherInlineActions: [] };
      const attachmentIdLine = !isWhatsapp && attachmentReadInlineAction
        ? `${formatEmailIdLabel(emailId, sourceChannel)} ${attachmentReadInlineAction}`
        : formatEmailIdLabel(emailId, sourceChannel);
      return {
        success: true,
        type: 'message',
        message: [
          attachmentIdLine,
          ...(isWhatsapp ? [`Read Link: ${buildReadEmailLink(emailId, sourceChannel)}`] : []),
          `From: ${emailRow?.from_raw ? String(emailRow.from_raw) : '(unknown sender)'}`,
          `Subject: ${emailRow?.subject ? String(emailRow.subject) : '(no subject)'}`,
          `Received: ${formatReceivedAtHuman(emailRow?.received_at)}`,
          ...(isWhatsapp
            ? [`Attachments: ${hasAttachments ? 'yes' : 'no'}`]
            : [`Attachments: ${hasAttachments ? attachmentRows.map((row) => row?.filename || '(unnamed)').join(', ') : 'no'}`]),
          ...(hasAttachments ? ['Attachment Details:', ...attachmentLines] : []),
          ...(!isWhatsapp ? attachmentOtherInlineActions : []),
        ].join('\n'),
        rows: responseRows,
        ui_actions: attachmentUiActions,
      };
    }

    if (isReplyMailRequest(prompt) || hasReplyFollowUpContext) {
      if (!sendMail) {
        return { success: false, message: 'Mail sending is not available.' };
      }
      try {
      let request = extractReplyMailRequest(prompt);
      let replyExtractRaw: string | null = null;
      try {
        const replyExtractPrompt = buildReplyExtractPrompt(requestPayload);
        replyExtractRaw = await sendToAssistant(replyExtractPrompt, { model: 'qwen2.5-coder:14b' });
      } catch (err: any) {
        // eslint-disable-next-line no-console
        console.log('Reply extract assistant failed ->', err?.message || String(err));
      }
      const replyExtract = replyExtractRaw ? parseReplyExtract(replyExtractRaw) : null;
      if (replyExtract) {
        if (replyExtract.mode === 'by_id' && replyExtract.email_id) {
          request = {
            mode: 'by_id',
            id: replyExtract.email_id,
            subject: replyExtract.subject,
            body: replyExtract.body,
          };
        } else if (
          replyExtract.mode === 'search' &&
          typeof replyExtract.search_query === 'string' &&
          replyExtract.search_query.trim().length > 0
        ) {
          request = {
            mode: 'search',
            query: replyExtract.search_query.trim(),
            subject: replyExtract.subject,
            body: replyExtract.body,
          };
        }
      }
      if (!request) {
        const selectedId = extractStandaloneEmailId(prompt);
        const candidateIds = extractCandidateIdsFromFollowUpContext(followUpContext);
        if (selectedId && (candidateIds.length === 0 || candidateIds.includes(selectedId))) {
          request = {
            mode: 'by_id',
            id: selectedId,
          };
        }
      }
      if (!request) {
        const followUpMessage =
          'Please provide reply body and target email id or search phrase (e.g., "reply to email 123 with ..." or "reply to emails from john with ...").';
        await appendFollowUpTurn(dbRun, prompt, followUpMessage);
        await setFollowUpActive(dbRun, true);
        return {
          success: true,
          type: 'message',
          message: followUpMessage,
          'follow-up-question': true,
          follow_up_question: true,
        };
      }
      let targetId = 0;
      let replyBody = '';
      let replySubject = '';
      const missingSubject = !request.subject || request.subject.trim().length === 0;
      let missingBody = !request.body || request.body.trim().length === 0;
      if (missingBody) {
        let deriveRaw: string | null = null;
        try {
          const derivePrompt = buildReplyBodyDerivePrompt(requestPayload);
          deriveRaw = await sendToAssistant(derivePrompt, { model: 'qwen2.5-coder:14b' });
        } catch (err: any) {
          // eslint-disable-next-line no-console
          console.log('Reply body derive assistant failed ->', err?.message || String(err));
        }
        const derived = deriveRaw ? parseReplyBodyDerive(deriveRaw) : null;
        if (derived?.body && derived.body.length > 0) {
          request.body = derived.body;
          missingBody = false;
        }
      }
      if (missingBody) {
        const followUpMessage = missingSubject
          ? 'Please provide the body for the reply. Subject will default to "Re: <original subject>".'
          : 'Please provide the body for the reply.';
        await appendFollowUpTurn(dbRun, prompt, followUpMessage);
        await setFollowUpActive(dbRun, true);
        return {
          success: true,
          type: 'message',
          message: followUpMessage,
          'follow-up-question': true,
          follow_up_question: true,
        };
      }
      if (request.mode === 'by_id') {
        targetId = request.id;
        replyBody = String(request.body || '').trim();
        replySubject = String(request.subject || '').trim();
      } else {
        const candidates = await loadReplyCandidates(dbAll, request.query, 10);
        const selectedId = extractStandaloneEmailId(prompt);
        if (candidates.length === 0) {
          return { success: false, message: `No emails matched "${request.query}" for reply.` };
        }
        const lines = candidates.map((row, index) => {
          const sender = row.from_raw || 'unknown sender';
          const subject = row.subject || '(no subject)';
          const received = formatReceivedAtHuman(row.received_at);
          const linkSegment = isWhatsappChannel(sourceChannel)
            ? ` | link=${buildReadEmailLink(row.id, sourceChannel)}`
            : '';
          const idSegment =
            isWhatsappChannel(sourceChannel)
              ? `email_id=${row.id}`
              : `id=${row.id}`;
          return `${index + 1}. ${idSegment}${linkSegment} | from=${sender} | subject=${subject} | received=${received}`;
        });
        if (!selectedId) {
          const askIdMessage = `Found ${candidates.length} match(es). Choose the email id you want to reply to.\n${lines.join('\n')}`;
          const replyCandidateActions = buildUiActionsForReplyCandidates(candidates, sourceChannel);
          await appendFollowUpTurn(dbRun, prompt, askIdMessage);
          await setFollowUpActive(dbRun, true);
          return {
            success: true,
            type: 'message',
            message: [
              askIdMessage,
              ...(!isWhatsappChannel(sourceChannel) ? renderInlineActions(replyCandidateActions) : []),
            ].join('\n'),
            ui_actions: replyCandidateActions,
            'follow-up-question': true,
            follow_up_question: true,
          };
        }
        const selected = candidates.find((row) => row.id === selectedId);
        if (!selected) {
          const askValidIdMessage = `Email id ${selectedId} is not in the current matches. Choose one of these ids:\n${lines.join('\n')}`;
          const replyCandidateActions = buildUiActionsForReplyCandidates(candidates, sourceChannel);
          await appendFollowUpTurn(dbRun, prompt, askValidIdMessage);
          await setFollowUpActive(dbRun, true);
          return {
            success: true,
            type: 'message',
            message: [
              askValidIdMessage,
              ...(!isWhatsappChannel(sourceChannel) ? renderInlineActions(replyCandidateActions) : []),
            ].join('\n'),
            ui_actions: replyCandidateActions,
            'follow-up-question': true,
            follow_up_question: true,
          };
        }
        targetId = selected.id;
        replyBody = String(request.body || '').trim();
        replySubject = String(request.subject || '').trim();
      }
      if (targetId === 0) {
        const selectedId = extractStandaloneEmailId(prompt);
        const candidateIds = extractCandidateIdsFromFollowUpContext(followUpContext);
        if (selectedId && (candidateIds.length === 0 || candidateIds.includes(selectedId))) {
          targetId = selectedId;
          replyBody = String(request.body || '').trim();
          replySubject = String(request.subject || '').trim();
        }
      }
      const source = await dbGet(
        `SELECT id, from_raw, subject
         FROM email_messages
         WHERE id = ?
         LIMIT 1;`,
        targetId,
      );
      if (!source?.id) {
        return { success: false, message: `Email ${targetId} was not found.` };
      }
      const to = extractEmailAddress(source?.from_raw ? String(source.from_raw) : null);
      if (!to) {
        return { success: false, message: `Could not determine sender address for email ${targetId}.` };
      }
      const originalSubject = source?.subject ? String(source.subject).trim() : '';
      if (missingSubject || replySubject.trim().length === 0) {
        replySubject = /^re:/i.test(originalSubject)
          ? originalSubject
          : `Re: ${originalSubject || `Email ${targetId}`}`;
      }
      if (!skipConfirmation && request.mode === 'by_id') {
        const confirmMessage = `Confirm reply to email ${targetId} (${to})?\nOriginal subject: ${originalSubject || '(no subject)'}\nSubject: ${replySubject}\nBody: ${replyBody}`;
        await appendFollowUpTurn(dbRun, prompt, confirmMessage);
        await setFollowUpActive(dbRun, true);
        return {
          success: true,
          confirm: true,
          message: confirmMessage,
        };
      }
      if (!skipConfirmation && request.mode === 'search') {
        const confirmMessage = `Confirm reply to email ${targetId} (${to})?\nOriginal subject: ${originalSubject || '(no subject)'}\nSubject: ${replySubject}\nBody: ${replyBody}`;
        await appendFollowUpTurn(dbRun, prompt, confirmMessage);
        await setFollowUpActive(dbRun, true);
        return {
          success: true,
          confirm: true,
          message: confirmMessage,
        };
      }
      try {
        const replyResult = await sendMail({
          to,
          subject: replySubject,
          body: replyBody,
        });
        const accepted = replyResult.accepted?.length ?? 0;
        const rejected = replyResult.rejected?.length ?? 0;
        const parts: string[] = [];
        if (accepted > 0) {
          parts.push(`Reply sent to ${to}.`);
        } else {
          parts.push('Reply send failed.');
        }
        if (accepted > 0 || rejected > 0) {
          parts.push(`Accepted: ${accepted}, Rejected: ${rejected}.`);
        }
        if (replyResult.messageId) {
          parts.push(`Message ID: ${replyResult.messageId}.`);
        } else if (replyResult.response) {
          parts.push(`Response: ${replyResult.response}.`);
        }
        await resetFollowUpContext(dbRun);
        return { success: accepted > 0, message: parts.join(' ') };
      } catch (err: any) {
        const reason = err?.message ? String(err.message) : 'Unknown error';
        return { success: false, message: `Reply failed: ${reason}` };
      }
      } catch (err: any) {
        // eslint-disable-next-line no-console
        console.log('Reply flow failed ->', err?.message || String(err));
        return {
          success: false,
          type: 'message',
          message: 'Unable to create/send reply right now. Please try again shortly.',
        };
      }
    }

    if (isMarkReadRequest(prompt)) {
      if (!markAsRead) {
        return { success: false, type: 'message', message: 'Mark-as-read is not available.' };
      }
      try {
        const payload = parseMarkReadPayload(prompt);
        const result = await markAsRead(payload);
        const parts = [
          `Marked ${result.marked} email${result.marked === 1 ? '' : 's'} as read.`,
        ];
        if (result.skipped > 0) {
          parts.push(`Skipped ${result.skipped}.`);
        }
        if (result.errors && result.errors.length > 0) {
          parts.push(`Errors: ${result.errors.join('; ')}`);
        }
        return { success: result.marked > 0 || result.found === 0, type: 'message', message: parts.join(' ') };
      } catch (err: any) {
        const reason = err?.message ? String(err.message) : 'Unknown error';
        return { success: false, type: 'message', message: `Mark-as-read failed: ${reason}` };
      }
    }

    if (isBlockEmailByIdRequest(prompt)) {
      const ids = parseDeleteIds(prompt);
      if (ids.length === 0) {
        return { success: false, confirm: false, message: 'Please provide a valid email id to block.' };
      }
      const emailId = ids[0];
      const row = await dbGet(
        `SELECT id, from_raw
         FROM email_messages
         WHERE id = ?
         LIMIT 1;`,
        emailId,
      );
      if (!row?.id) {
        return { success: false, confirm: false, message: `Email ${emailId} was not found.` };
      }
      const fromRaw = row?.from_raw ? String(row.from_raw) : '';
      const extracted = extractEmailAddress(fromRaw);
      const pattern = (extracted || fromRaw).trim().toLowerCase();
      if (!pattern) {
        return { success: false, confirm: false, message: `Sender could not be determined for email ${emailId}.` };
      }
      const matchedIds = await loadMessageIdsForSenderPatterns(dbAll, [pattern]);
      if (!skipConfirmation) {
        return {
          success: true,
          confirm: true,
          message: `Confirm blocking sender "${pattern}" from email ${emailId}? This will move ${matchedIds.length} current email${matchedIds.length === 1 ? '' : 's'} to Trash.`,
        };
      }
      await dbRun(
        `INSERT INTO blocked_senders (pattern)
         VALUES (?)
         ON CONFLICT(pattern) DO NOTHING;`,
        pattern,
      );
      let movedServer = 0;
      let movedLocal = 0;
      let errors: string[] = [];
      if (matchedIds.length > 0 && deleteMail) {
        try {
          const deleteResult = await deleteMail({ ids: matchedIds });
          movedServer = deleteResult.deleted;
          if (deleteResult.errors && deleteResult.errors.length > 0) {
            errors = errors.concat(deleteResult.errors);
          }
          movedLocal = deleteResult.deleted;
        } catch (err: any) {
          const reason = err?.message ? String(err.message) : 'unknown server move error';
          errors.push(reason);
        }
      }
      if (matchedIds.length > 0 && (!deleteMail || movedServer === 0)) {
        const localMoved = await moveMessageIdsToLocalTrash(dbGet, dbRun, matchedIds);
        movedLocal = Math.max(movedLocal, localMoved);
      }
      return {
        success: true,
        confirm: false,
        message: [
          `Blocked sender "${pattern}" from email ${emailId}.`,
          `Moved ${movedLocal} current email${movedLocal === 1 ? '' : 's'} to Trash locally.`,
          deleteMail ? `Moved ${movedServer} email${movedServer === 1 ? '' : 's'} to Trash on server.` : 'Server move unavailable.',
          ...(errors.length > 0 ? [`Errors: ${errors.join('; ')}`] : []),
        ].join(' '),
      };
    }

    if (isBlockSenderRequest(prompt)) {
      const patterns = extractBlockPatterns(prompt);
      if (patterns.length === 0) {
        return {
          success: false,
          confirm: false,
          message: 'Please provide sender patterns to block.',
        };
      }
      const matches = await loadSenderMatches(dbAll, patterns);
      const matchedMessageIds = await loadMessageIdsForSenderPatterns(dbAll, patterns);
      const anyMatches = matches.some((entry) => entry.matches.length > 0);
      if (!anyMatches) {
        return {
          success: true,
          confirm: false,
          message: 'No matching senders found to block.',
        };
      }
      if (!skipConfirmation) {
        return {
          success: true,
          confirm: true,
          message: `${formatBlockConfirm(matches)} This will move ${matchedMessageIds.length} current email${matchedMessageIds.length === 1 ? '' : 's'} to Trash.`,
        };
      }
      const uniquePatterns = Array.from(new Set(patterns));
      for (const pattern of uniquePatterns) {
        await dbRun(
          'INSERT OR IGNORE INTO blocked_senders (pattern) VALUES (?);',
          pattern,
        );
      }
      for (const entry of matches) {
        for (const sender of entry.matches) {
          // eslint-disable-next-line no-console
          console.log(`[blocked] pattern="${entry.pattern}" sender="${sender}"`);
        }
      }
      const blockedCount = uniquePatterns.length;
      const hitCount = matches.reduce((sum, entry) => sum + entry.matches.length, 0);
      let movedServer = 0;
      let movedLocal = 0;
      let moveErrors: string[] = [];
      if (matchedMessageIds.length > 0 && deleteMail) {
        try {
          const moveResult = await deleteMail({ ids: matchedMessageIds });
          movedServer = moveResult.deleted;
          movedLocal = moveResult.deleted;
          if (moveResult.errors && moveResult.errors.length > 0) {
            moveErrors = moveErrors.concat(moveResult.errors);
          }
        } catch (err: any) {
          const reason = err?.message ? String(err.message) : 'unknown server move error';
          moveErrors.push(reason);
        }
      }
      if (matchedMessageIds.length > 0 && (!deleteMail || movedServer === 0)) {
        const localMoved = await moveMessageIdsToLocalTrash(dbGet, dbRun, matchedMessageIds);
        movedLocal = Math.max(movedLocal, localMoved);
      }
      return {
        success: true,
        confirm: false,
        message: [
          `Blocked ${blockedCount} sender pattern${blockedCount === 1 ? '' : 's'}. Matches logged: ${hitCount}.`,
          `Moved ${movedLocal} current email${movedLocal === 1 ? '' : 's'} to Trash locally.`,
          deleteMail ? `Moved ${movedServer} email${movedServer === 1 ? '' : 's'} to Trash on server.` : 'Server move unavailable.',
          ...(moveErrors.length > 0 ? [`Errors: ${moveErrors.join('; ')}`] : []),
        ].join(' '),
      };
    }

    if (isShowBlocklistRequest(prompt)) {
      const rows = await dbAll('SELECT id, pattern, created_at FROM blocked_senders ORDER BY id ASC;');
      if (!rows || rows.length === 0) {
        return { success: true, confirm: false, message: 'Blocklist is empty.' };
      }
      const lines: string[] = [];
      for (const row of rows) {
        const id = row?.id ?? null;
        const pattern = row?.pattern ? String(row.pattern) : '(unknown)';
        const createdAt = row?.created_at ? String(row.created_at) : '';
        const matchesRows = await dbAll(
          'SELECT DISTINCT from_raw FROM email_messages WHERE LOWER(from_raw) LIKE ?;',
          `%${pattern.toLowerCase()}%`,
        );
        const matches = matchesRows
          .map((entry) => (entry?.from_raw ? String(entry.from_raw) : ''))
          .map((value) => value.trim())
          .filter((value) => value.length > 0);
        const headerBase = createdAt ? `${pattern} (${createdAt})` : pattern;
        const header = id !== null && id !== undefined ? `#${id} ${headerBase}` : headerBase;
        const detail = matches.length > 0 ? matches.join('; ') : 'no matches';
        lines.push(`${header}: ${detail}`);
      }
      return {
        success: true,
        confirm: false,
        message: lines.join('\n'),
      };
    }

    if (isUnblockByIdRequest(prompt)) {
      const ids = extractUnblockIds(prompt);
      if (ids.length === 0) {
        return {
          success: false,
          confirm: false,
          message: 'Please provide blocklist ids to remove.',
        };
      }
      const placeholders = ids.map(() => '?').join(', ');
      const rows = await dbAll(
        `SELECT id, pattern FROM blocked_senders WHERE id IN (${placeholders});`,
        ...ids,
      );
      if (!rows || rows.length === 0) {
        return {
          success: true,
          confirm: false,
          message: 'No matching blocklist entries found.',
        };
      }
      if (!skipConfirmation) {
        const details = rows
          .map((row) => `#${row.id} ${row.pattern}`)
          .join('; ');
        return {
          success: true,
          confirm: true,
          message: `Confirm removing blocklist entries: ${details}.`,
        };
      }
      await dbRun(
        `DELETE FROM blocked_senders WHERE id IN (${placeholders});`,
        ...ids,
      );
      return {
        success: true,
        confirm: false,
        message: `Removed ${rows.length} blocklist entr${rows.length === 1 ? 'y' : 'ies'}.`,
      };
    }

    if (isClearBlocklistRequest(prompt)) {
      const rows = await dbAll('SELECT id, pattern FROM blocked_senders ORDER BY id ASC;');
      if (!rows || rows.length === 0) {
        return {
          success: true,
          confirm: false,
          message: 'Blocklist is already empty.',
        };
      }
      if (!skipConfirmation) {
        const summary = rows.map((row) => `#${row.id} ${row.pattern}`).join('; ');
        return {
          success: true,
          confirm: true,
          message: `Confirm removing all blocklist entries: ${summary}.`,
        };
      }
      await dbRun('DELETE FROM blocked_senders;');
      return {
        success: true,
        confirm: false,
        message: `Removed ${rows.length} blocklist entr${rows.length === 1 ? 'y' : 'ies'}.`,
      };
    }

    if (isUnblockSenderRequest(prompt)) {
      const patterns = extractUnblockPatterns(prompt);
      if (patterns.length === 0) {
        return {
          success: false,
          confirm: false,
          message: 'Please provide sender patterns to unblock.',
        };
      }
      const matches = await loadBlockedPatternMatches(dbAll, patterns);
      const anyMatches = matches.some((entry) => entry.matches.length > 0);
      if (!anyMatches) {
        return {
          success: true,
          confirm: false,
          message: 'No matching blocked senders found.',
        };
      }
      if (!skipConfirmation) {
        return {
          success: true,
          confirm: true,
          message: formatUnblockConfirm(matches),
        };
      }
      const toRemove = matches.flatMap((entry) => entry.matches);
      const uniqueRemove = Array.from(new Set(toRemove));
      if (uniqueRemove.length > 0) {
        const placeholders = uniqueRemove.map(() => '?').join(', ');
        await dbRun(
          `DELETE FROM blocked_senders WHERE pattern IN (${placeholders});`,
          ...uniqueRemove,
        );
      }
      for (const removed of uniqueRemove) {
        // eslint-disable-next-line no-console
        console.log(`[unblocked] pattern="${removed}"`);
      }
      const removedCount = uniqueRemove.length;
      return {
        success: true,
        confirm: false,
        message: `Unblocked ${removedCount} sender pattern${removedCount === 1 ? '' : 's'}.`,
      };
    }

    if (isEmptyTrashRequest(prompt)) {
      if (!deleteTrash) {
        return { success: false, confirm: false, message: 'Trash deletion is not available.' };
      }
      try {
        const result = await deleteTrash();
        if (result.found === 0) {
          return { success: true, confirm: false, message: 'Trash is already empty.' };
        }
        if (result.deleted === 0) {
          return {
            success: false,
            confirm: false,
            message: 'Trash could not be emptied.',
          };
        }
        const parts = [
          `Emptied trash: deleted ${result.deleted} email${result.deleted === 1 ? '' : 's'}.`,
        ];
        if (result.skipped > 0) {
          parts.push(`Skipped ${result.skipped}.`);
        }
        if (result.errors && result.errors.length > 0) {
          parts.push(`Errors: ${result.errors.join('; ')}`);
        }
        return { success: result.deleted > 0, confirm: false, message: parts.join(' ') };
      } catch (err: any) {
        const reason = err?.message ? String(err.message) : 'Unknown error';
        return { success: false, confirm: false, message: `Trash empty failed: ${reason}` };
      }
    }

    const folderToEmpty = extractFolderToEmpty(prompt);
    if (folderToEmpty) {
      const loweredFolder = folderToEmpty.toLowerCase();
      if (loweredFolder === 'inbox' || loweredFolder === 'sent') {
        return {
          success: false,
          confirm: false,
          message: `${loweredFolder === 'sent' ? 'Sent folder' : 'Inbox'} cannot be emptied.`,
        };
      }
      if (!deleteFolder) {
        return { success: false, confirm: false, message: 'Folder deletion is not available.' };
      }
      if (!skipConfirmation) {
        return {
          success: true,
          confirm: true,
          message: `Confirm emptying folder "${folderToEmpty}"?`,
        };
      }
      try {
        const result = await deleteFolder({ name: folderToEmpty });
        if (result.found === 0) {
          return {
            success: true,
            confirm: false,
            message: `Folder "${folderToEmpty}" is already empty or not found.`,
          };
        }
        if (result.deleted === 0) {
          return {
            success: false,
            confirm: false,
            message: `Folder "${folderToEmpty}" could not be emptied.`,
          };
        }
        const parts = [
          `Emptied "${folderToEmpty}": deleted ${result.deleted} email${result.deleted === 1 ? '' : 's'}.`,
        ];
        if (result.skipped > 0) {
          parts.push(`Skipped ${result.skipped}.`);
        }
        if (result.errors && result.errors.length > 0) {
          parts.push(`Errors: ${result.errors.join('; ')}`);
        }
        return { success: result.deleted > 0, confirm: false, message: parts.join(' ') };
      } catch (err: any) {
        const reason = err?.message ? String(err.message) : 'Unknown error';
        return {
          success: false,
          confirm: false,
          message: `Folder empty failed: ${reason}`,
        };
      }
    }

    if (isDeleteMailRequest(prompt)) {
      if (!deleteMail) {
        return { success: false, message: 'Mail deletion is not available.' };
      }
      let ids = parseDeleteIds(prompt);
      if (ids.length === 0) {
        ids = await resolveRelativeDeleteIds(dbGet, prompt);
      }
      if (ids.length === 0) {
        return {
          success: false,
          confirm: false,
          message: 'Email ids are required for deletion.',
        };
      }
      const existingIds = await loadExistingMessageIds(dbAll, ids);
      if (existingIds.length === 0) {
        return {
          success: true,
          confirm: false,
          message: 'No matching emails found to delete.',
        };
      }
      if (!skipConfirmation) {
        return {
          success: true,
          confirm: true,
          message: `Confirm deletion of ${existingIds.length} email${existingIds.length === 1 ? '' : 's'}?`,
        };
      }
      try {
        const result = await deleteMail({ ids });
        const parts = [
          `Moved ${result.deleted} email${result.deleted === 1 ? '' : 's'} to trash.`,
        ];
        if (result.skipped > 0) {
          parts.push(`Skipped ${result.skipped}.`);
        }
        if (result.errors && result.errors.length > 0) {
          parts.push(`Errors: ${result.errors.join('; ')}`);
        }
        return { success: result.deleted > 0, confirm: false, message: parts.join(' ') };
      } catch (err: any) {
        const reason = err?.message ? String(err.message) : 'Unknown error';
        return { success: false, confirm: false, message: `Email delete failed: ${reason}` };
      }
    }

    if (isMoveMailRequest(prompt)) {
      if (!moveMail) {
        return { success: false, message: 'Mail move is not available.' };
      }
      const folder = extractMoveFolder(prompt);
      let ids = parseDeleteIds(prompt);
      if (ids.length === 0) {
        ids = await resolveRelativeDeleteIds(dbGet, prompt);
      }
      if (!folder) {
        return {
          success: false,
          confirm: false,
          message: 'Target folder is required. Example: move email 123 to INBOX.topay',
        };
      }
      if (ids.length === 0) {
        return {
          success: false,
          confirm: false,
          message: 'Email ids are required for move.',
        };
      }
      const existingIds = await loadExistingMessageIds(dbAll, ids);
      if (existingIds.length === 0) {
        return {
          success: true,
          confirm: false,
          message: 'No matching emails found to move.',
        };
      }
      try {
        const result = await moveMail({ ids, folder });
        const parts = [
          `Moved ${result.moved} email${result.moved === 1 ? '' : 's'} to ${result.target_folder}.`,
        ];
        if (result.skipped > 0) {
          parts.push(`Skipped ${result.skipped}.`);
        }
        if (result.errors && result.errors.length > 0) {
          parts.push(`Errors: ${result.errors.join('; ')}`);
        }
        return { success: result.moved > 0, confirm: false, message: parts.join(' ') };
      } catch (err: any) {
        const reason = err?.message ? String(err.message) : 'Unknown error';
        return { success: false, confirm: false, message: `Email move failed: ${reason}` };
      }
    }

    if (shouldCheckLearningsSql(prompt)) {
      const learningsPrompt = buildLearningsSqlPrompt(requestPayload);
      const learningsRaw = await sendToAssistant(learningsPrompt, { model: 'qwen2.5-coder:14b' });
      const learningsSql = learningsRaw ? parseLearningsSql(learningsRaw) : null;
      if (learningsSql && learningsSql.action !== 'none') {
        const resultData = await runLearningsSql(learningsSql.sql);
        if (learningsSql.action === 'list') {
          return { success: true, message: formatLearningsRows(resultData.rows) };
        }
        if (learningsSql.action === 'delete') {
          await refreshLearnings();
          return { success: true, message: 'Learning removed.' };
        }
      }
    }

    const verb = parseVerb(result);
    const intent = parseIntent(result);
    if (isLearningIntent(verb, intent, prompt)) {
      const learningPrompt = buildLearningExtractPrompt(requestPayload);
      const learningRaw = await sendToAssistant(learningPrompt);
      const learningExtract = learningRaw ? parseLearningExtract(learningRaw) : null;
      if (learningExtract?.should_learn && learningExtract.learning) {
        await appendLearning(learningExtract.learning);
        return { success: true, message: "Got it. I've added that learning." };
      }
    }

    const isFollowUpRound = hasFollowUpContext || followUpHint;

    if (isCountMailRequest(prompt) && !isFollowUpRound) {
      const folderHint = extractFolderHint(prompt);
      if (!folderHint) {
        return {
          success: true,
          type: 'message',
          message: "Which folder would you like to check for the number of emails? You can specify 'inbox', 'sent', 'archive', or 'trash'.",
          'follow-up-question': true,
          follow_up_question: true,
        };
      }

      let whereClause = '';
      let params: unknown[] = [];
      const normalizedFolder = folderHint.toLowerCase();
      if (normalizedFolder === 'inbox') {
        whereClause = "(LOWER(folders.name) = 'inbox' OR LOWER(folders.path) = 'inbox')";
      } else if (normalizedFolder === 'sent') {
        whereClause = "(LOWER(folders.name) = 'sent' OR LOWER(folders.path) = 'inbox.sent')";
      } else if (normalizedFolder === 'trash') {
        whereClause = "(LOWER(folders.name) = 'trash' OR LOWER(folders.path) LIKE '%trash%')";
      } else if (normalizedFolder === 'archive' || normalizedFolder === 'archived') {
        whereClause = "(LOWER(folders.name) LIKE '%archive%' OR LOWER(folders.path) LIKE '%archive%')";
      } else {
        whereClause = '(LOWER(folders.name) = ? OR LOWER(folders.path) LIKE ?)';
        params = [normalizedFolder, `%${normalizedFolder}%`];
      }

      const sql =
        `SELECT COUNT(email_messages.id) AS total_count ` +
        `FROM email_messages ` +
        `INNER JOIN folders ON email_messages.folder_id = folders.id ` +
        `WHERE ${whereClause};`;
      const rows = await dbAll(sql, ...params);
      const total = Number(rows?.[0]?.total_count ?? 0);
      const label = normalizedFolder === 'archived' ? 'archive' : normalizedFolder;
      return {
        success: true,
        sql,
        rows,
        message: `Total emails in ${label}: ${Number.isFinite(total) ? total : 0}`,
      };
    }

    if (!isFollowUpRound && isDirectAttachmentFetchByIdRequest(prompt)) {
      const response = await handleAttachmentIntent({
        dbAll,
        dbGet,
        dbRun,
        prompt,
        mode: 'fetch',
        sourceChannel,
      });
      if (hasFollowUpContext) {
        await resetFollowUpContext(dbRun);
      }
      return response;
    }

    if (isSimpleListEmailsPrompt(prompt) && !isFollowUpRound) {
      const wantAllDirect = wantsAllResults(prompt);
      const requestedLimitDirect = extractRequestedEmailLimit(prompt);
      const senderTermDirect = extractSenderFilterTerm(prompt);
      const folderHintDirect = extractFolderHint(prompt);
      const todayMyMails = isTodayMyMailsPrompt(prompt);
      const weekdayRange = extractWeekdayDateRange(prompt);
      const now = new Date();
      const startOfLocalDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      const startOfNextLocalDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
      const safeLimit = wantAllDirect
        ? 500
        : requestedLimitDirect && requestedLimitDirect > 0
          ? requestedLimitDirect
          : 10;
      const directSqlBase =
        `SELECT email_messages.id, email_messages.from_raw, email_messages.subject, email_messages.received_at, ` +
        `(SELECT GROUP_CONCAT(filename, ', ') FROM email_attachments WHERE email_attachments.email_id = email_messages.id) AS attachments ` +
        `FROM email_messages ` +
        `INNER JOIN folders ON folders.id = email_messages.folder_id `;
      const directWhere = senderTermDirect
        ? `WHERE LOWER(COALESCE(email_messages.from_raw, '')) LIKE ? AND email_messages.received_at IS NOT NULL `
        : `WHERE email_messages.received_at IS NOT NULL `;
      let directWhereWithFolder = directWhere;
      if (folderHintDirect) {
        const folder = folderHintDirect.toLowerCase();
        if (folder === 'inbox') {
          directWhereWithFolder +=
            `AND (` +
            `LOWER(folders.path) = 'inbox' OR LOWER(folders.path) = 'inbox.inbox'` +
            `) `;
        } else if (folder === 'sent') {
          directWhereWithFolder +=
            `AND (` +
            `LOWER(folders.path) = 'sent' OR LOWER(folders.path) = 'inbox.sent'` +
            `) `;
        } else if (folder === 'topay') {
          directWhereWithFolder +=
            `AND (` +
            `LOWER(folders.path) = 'topay' OR LOWER(folders.path) = 'inbox.topay' OR LOWER(folders.path) LIKE 'inbox.topay.%'` +
            `) `;
        } else {
          directWhereWithFolder +=
            `AND (` +
            `LOWER(folders.name) = ? OR LOWER(folders.path) = ? OR LOWER(folders.path) LIKE ?` +
            `) `;
        }
      } else {
        directWhereWithFolder +=
          `AND (` +
          `LOWER(folders.path) = 'inbox' OR LOWER(folders.path) = 'inbox.inbox'` +
          `) `;
      }
      const directWhereWithDate = (todayMyMails || weekdayRange)
        ? `${directWhereWithFolder}AND email_messages.received_at >= ? AND email_messages.received_at < ? `
        : directWhereWithFolder;
      const directOrder = `ORDER BY email_messages.received_at DESC, email_messages.id DESC `;
      const directLimit = wantAllDirect || todayMyMails || Boolean(weekdayRange) ? '' : `LIMIT ${safeLimit}`;
      const directSql = `${directSqlBase}${directWhereWithDate}${directOrder}${directLimit}`.trim();
      const directRowsParams: unknown[] = [];
      if (senderTermDirect) {
        directRowsParams.push(`%${senderTermDirect}%`);
      }
      if (folderHintDirect) {
        const folder = folderHintDirect.toLowerCase();
        if (folder !== 'inbox' && folder !== 'sent' && folder !== 'topay') {
          directRowsParams.push(folder, folder, `%${folder}%`);
        }
      }
      if (todayMyMails) {
        directRowsParams.push(startOfLocalDay.toISOString(), startOfNextLocalDay.toISOString());
      } else if (weekdayRange) {
        directRowsParams.push(weekdayRange.startIso, weekdayRange.endIso);
      }
      const directRows = await dbAll(directSql, ...directRowsParams);
      const wantsDetailed = isDetailedEmailRequest(prompt);
      const responseRows = wantsDetailed ? await enrichRowsWithTextBody(dbAll, directRows) : directRows;
      const emailViewerRows = await buildEmailViewerRows(dbAll, responseRows);
      const humanMessage = wantsDetailed
        ? formatEmailRowsDetailed(responseRows, sourceChannel)
        : formatEmailRowsBasic(responseRows, sourceChannel);
      const uiActions = buildUiActionsForEmailRows(responseRows, sourceChannel);
      const responsePayload = {
        success: true,
        sql: directSql,
        rows: responseRows,
        email_viewer_rows: emailViewerRows,
        message: humanMessage ?? undefined,
        ui_actions: uiActions,
      };
      // eslint-disable-next-line no-console
      console.log('LLM response payload ->', JSON.stringify(responsePayload));
      return responsePayload;
    }

    if (isExplicitEmailSearchPrompt(prompt) && !isFollowUpRound) {
      const wantAllSearch = wantsAllResults(prompt);
      const requestedLimitSearch = extractRequestedEmailLimit(prompt);
      const safeLimit = wantAllSearch
        ? 500
        : requestedLimitSearch && requestedLimitSearch > 0
          ? requestedLimitSearch
          : 10;
      const searchTerm = extractEmailSearchTerm(prompt) || '';
      const lowered = searchTerm.toLowerCase().trim();
      const tokens = lowered
        .split(/[^a-z0-9@._%+\-]+/g)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2);
      const params: unknown[] = [];
      const clauses: string[] = [];
      const haystack =
        "LOWER(COALESCE(email_messages.from_raw, '') || ' ' || COALESCE(email_messages.subject, '') || ' ' || COALESCE(email_messages.text_body, ''))";
      if (lowered.length > 0) {
        clauses.push(`${haystack} LIKE ?`);
        params.push(`%${lowered}%`);
      }
      for (const token of tokens.slice(0, 8)) {
        clauses.push(`${haystack} LIKE ?`);
        params.push(`%${token}%`);
      }
      if (clauses.length === 0) {
        return { success: true, message: 'Please provide a search term.' };
      }
      const whereClause = clauses.length === 1 ? clauses[0] : `(${clauses.join(' AND ')})`;
      const searchSqlBase =
        `SELECT email_messages.id, email_messages.from_raw, email_messages.subject, email_messages.received_at, ` +
        `(SELECT GROUP_CONCAT(filename, ', ') FROM email_attachments WHERE email_attachments.email_id = email_messages.id) AS attachments ` +
        `FROM email_messages ` +
        `WHERE ${whereClause} ` +
        `AND email_messages.received_at IS NOT NULL ` +
        `ORDER BY email_messages.received_at DESC, email_messages.id DESC`;
      const searchSql = wantAllSearch ? searchSqlBase : `${searchSqlBase} LIMIT ${safeLimit}`;
      const searchRows = await dbAll(searchSql, ...params);
      const wantsDetailed = isDetailedEmailRequest(prompt);
      const responseRows = wantsDetailed ? await enrichRowsWithTextBody(dbAll, searchRows) : searchRows;
      const emailViewerRows = await buildEmailViewerRows(dbAll, responseRows);
      const humanMessage = wantsDetailed
        ? formatEmailRowsDetailed(responseRows, sourceChannel)
        : formatEmailRowsBasic(responseRows, sourceChannel);
      const uiActions = buildUiActionsForEmailRows(responseRows, sourceChannel);
      const responsePayload = {
        success: true,
        sql: searchSql,
        rows: responseRows,
        email_viewer_rows: emailViewerRows,
        message: humanMessage ?? undefined,
        ui_actions: uiActions,
      };
      // eslint-disable-next-line no-console
      console.log('LLM response payload ->', JSON.stringify(responsePayload));
      return responsePayload;
    }

    const cacheEnabled =
      String(process.env.CACHE_QUERRIES || 'false').toLowerCase() === 'true' &&
      !skipSqlCacheForRequest &&
      !skipCacheHint &&
      !shouldBypassSqlCache(prompt) &&
      !isFollowUpRound;
    const wantAll = wantsAllResults(prompt);
    const cacheKey = cacheKeyFor(prompt, result);
    const maxAttempts = 3;
    let attempt = 0;
    let lastErrorMessage = '';
    let lastSql = '';

    if (cacheEnabled) {
      try {
        const cached = await dbGet(
          'SELECT sql FROM llm_sql_cache WHERE key = ? LIMIT 1;',
          cacheKey,
        );
        if (cached?.sql) {
            // eslint-disable-next-line no-console
            console.log('[cache] SQL hit');
          try {
            const effectiveCachedSql = wantAll ? removeLimitClause(cached.sql) : cached.sql;
            const rows = await dbAll(effectiveCachedSql);
            const requestedLimit = extractRequestedEmailLimit(prompt);
            const expanded = await maybeExpandSenderScopedRows(dbAll, prompt, requestedLimit, wantAll, rows);
            const finalRows = expanded.rows;
            const finalSql = expanded.sql || effectiveCachedSql;
            const wantsDetailed = isDetailedEmailRequest(prompt);
            const responseRows = wantsDetailed ? await enrichRowsWithTextBody(dbAll, finalRows) : finalRows;
            const emailViewerRows = await buildEmailViewerRows(dbAll, responseRows);
            const humanMessage = wantsDetailed
              ? formatEmailRowsDetailed(responseRows, sourceChannel)
              : formatEmailRowsBasic(responseRows, sourceChannel);
            const uiActions = buildUiActionsForEmailRows(responseRows, sourceChannel);
            const responsePayload = {
              success: true,
              sql: finalSql,
              rows: responseRows,
              email_viewer_rows: emailViewerRows,
              message: humanMessage ?? undefined,
              ui_actions: uiActions,
            };
            // eslint-disable-next-line no-console
            console.log('LLM response payload ->', JSON.stringify(responsePayload));
            return responsePayload;
          } catch (err: any) {
            // eslint-disable-next-line no-console
            console.log('[cache] SQL failed, evicting cache');
            await dbRun('DELETE FROM llm_sql_cache WHERE key = ?;', cacheKey);
          }
        } else {
          // eslint-disable-next-line no-console
          console.log('[cache] SQL miss');
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.log('[cache] SQL check failed');
      }
    }

    while (attempt < maxAttempts) {
      const emailPrompt = buildEmailSqlPrompt(requestPayload);
      const emailRaw = await sendToAssistant(emailPrompt, { model: 'qwen2.5-coder:14b' });
      const emailSql = emailRaw ? parseEmailSql(emailRaw) : null;
      if (!emailSql) {
        return { success: false, message: 'Unable to generate SQL.' };
      }
      if (emailSql.follow_up_question) {
        if (EMAIL_DISABLE_FOLLOW_UP_QUESTIONS) {
          attempt += 1;
          if (attempt >= maxAttempts) {
            return {
              success: false,
              message: 'Unable to resolve request details without follow-up. Please rephrase with specific details.',
            };
          }
          requestPayload.follow_up_context = undefined;
          requestPayload.previous_sql = '';
          requestPayload.error = 'Follow-up questions are disabled. Return a best-effort SQL response.';
          continue;
        }
        const followUpMessage =
          typeof emailSql.follow_up_message === 'string' && emailSql.follow_up_message.trim().length > 0
            ? emailSql.follow_up_message.trim()
            : 'Please provide the missing details so I can continue.';
        await appendFollowUpTurn(dbRun, prompt, followUpMessage);
        await setFollowUpActive(dbRun, true);
        return {
          success: true,
          type: 'message',
          message: followUpMessage,
          'follow-up-question': true,
          follow_up_question: true,
        };
      }
      if (emailSql.delivery === 'attach' || emailSql.delivery === 'read') {
        const response = await handleAttachmentIntent({
          dbAll,
          dbGet,
          dbRun,
          prompt,
          mode: emailSql.delivery === 'read' ? 'read' : 'fetch',
          sourceChannel,
        });
        if (hasFollowUpContext) {
          await resetFollowUpContext(dbRun);
        }
        return response;
      }
      if (!emailSql?.sql) {
        return { success: false, message: 'Unable to generate SQL.' };
      }

      const isLastRequest = isExplicitLastOne(prompt);
      const requestedLimit = extractRequestedEmailLimit(prompt);
      const baseSql = isLastRequest
        ? enforceLatestOrder(emailSql.sql)
        : normalizeSql(emailSql.sql);
      const orderedSql = enforceDefaultRecentOrder(baseSql, prompt);
      const withAllHandling = wantAll ? removeLimitClause(orderedSql) : orderedSql;
      const candidateSql = applyRequestedLimit(withAllHandling, requestedLimit);

      lastSql = candidateSql;

      try {
        const rows = await dbAll(candidateSql);
        const expanded = await maybeExpandSenderScopedRows(dbAll, prompt, requestedLimit, wantAll, rows);
        const finalRows = expanded.rows;
        const finalSql = expanded.sql || candidateSql;
        const wantsDetailed = isDetailedEmailRequest(prompt);
        const responseRows = wantsDetailed ? await enrichRowsWithTextBody(dbAll, finalRows) : finalRows;
        const emailViewerRows = await buildEmailViewerRows(dbAll, responseRows);
        const humanMessage = wantsDetailed
          ? formatEmailRowsDetailed(responseRows, sourceChannel)
          : formatEmailRowsBasic(responseRows, sourceChannel);
        const uiActions = buildUiActionsForEmailRows(responseRows, sourceChannel);
        const responsePayload = {
          success: true,
          sql: finalSql,
          rows: responseRows,
          email_viewer_rows: emailViewerRows,
          message: humanMessage ?? undefined,
          ui_actions: uiActions,
        };
        // eslint-disable-next-line no-console
        console.log('LLM response payload ->', JSON.stringify(responsePayload));
        if (cacheEnabled) {
          await dbRun(
            'INSERT OR REPLACE INTO llm_sql_cache (key, sql) VALUES (?, ?);',
            cacheKey,
            candidateSql,
          );
        }
        if (hasFollowUpContext) {
          await resetFollowUpContext(dbRun);
        }
        return responsePayload;
      } catch (err: any) {
        lastErrorMessage = `SQL execution failed: ${err?.message || 'unknown error'}`;
        // eslint-disable-next-line no-console
        console.log('LLM SQL error ->', lastErrorMessage);
        attempt += 1;
        if (attempt >= maxAttempts) {
          const errorPayload = {
            success: false,
            message: lastErrorMessage,
          };
          // eslint-disable-next-line no-console
          console.log('LLM response payload ->', JSON.stringify(errorPayload));
          return errorPayload;
        }
        requestPayload.previous_sql = lastSql;
        requestPayload.error = lastErrorMessage;
      }
    }

    return { success: false, message: lastErrorMessage || 'SQL execution failed.' };
  };
}
