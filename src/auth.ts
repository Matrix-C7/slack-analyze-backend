import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Document } from 'mongodb';
import { config } from './config.js';
import { col, nextId } from './db/mongo.js';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export const SESSION_COOKIE = 'sa_session';
const SESSION_DAYS = 14;

export type Role = 'admin' | 'viewer';

export interface AccountGrant {
  workspaceId: string;
  accountId: string;
}

export interface SessionUser {
  id: number;
  email: string;
  name: string | null;
  role: Role;
  /** false: only the workspaces in `workspaceIds` are visible (ignored for admins). */
  allWorkspaces: boolean;
  /** false: only the Slack accounts in `accountGrants` are visible (ignored for admins). */
  allAccounts: boolean;
  workspaceIds: string[];
  accountGrants: AccountGrant[];
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

function readCookie(req: FastifyRequest, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function cookieHeader(value: string, maxAgeSec: number): string {
  const crossSite = config.cookieSameSite === 'none';
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    `SameSite=${crossSite ? 'None' : 'Lax'}`,
    `Max-Age=${maxAgeSec}`,
  ];
  // SameSite=None is ignored unless Secure. Partitioned keeps the cookie working in Chrome
  // when the dashboard (Vercel) and API (Render) are different sites.
  if (config.cookieSecure || crossSite) attrs.push('Secure');
  if (crossSite) attrs.push('Partitioned');
  return attrs.join('; ');
}

/** app_users document → session user. */
export function toSessionUser(u: Document): SessionUser {
  return {
    id: Number(u.id),
    email: u.email,
    name: u.name ?? null,
    role: u.role,
    allWorkspaces: u.all_workspaces !== false,
    allAccounts: u.all_accounts !== false,
    workspaceIds: u.workspace_ids ?? [],
    accountGrants: u.account_grants ?? [],
  };
}

/** What /api/auth/me returns (the grant lists stay server-side). */
export const publicUser = ({ workspaceIds: _w, accountGrants: _a, ...u }: SessionUser) => u;

export async function createSession(req: FastifyRequest, reply: FastifyReply, userId: number): Promise<void> {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  await col.appSessions.insertOne({
    token_hash: sha256(token),
    user_id: userId,
    user_agent: req.headers['user-agent']?.slice(0, 300) ?? null,
    ip: req.ip,
    created_at: now,
    last_used_at: now,
    expires_at: new Date(now.getTime() + SESSION_DAYS * 86400_000),
  });
  await col.appUsers.updateOne({ id: userId }, { $set: { last_login_at: now } });
  reply.header('Set-Cookie', cookieHeader(token, SESSION_DAYS * 86400));
}

export async function destroySession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) await col.appSessions.deleteOne({ token_hash: sha256(token) });
  reply.header('Set-Cookie', cookieHeader('', 0));
}

/** Resolves the session cookie to an active user (or undefined). */
export async function loadUser(req: FastifyRequest): Promise<SessionUser | undefined> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return undefined;
  const s = await col.appSessions.findOneAndUpdate(
    { token_hash: sha256(token), expires_at: { $gt: new Date() } },
    { $set: { last_used_at: new Date() } },
  );
  if (!s) return undefined;
  const u = await col.appUsers.findOne({ id: s.user_id, is_active: true });
  return u ? toSessionUser(u) : undefined;
}

/** onRequest hook: any logged-in user. */
export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  req.user = await loadUser(req);
  if (!req.user) return reply.code(401).send({ error: 'login required' });
}

/** onRequest hook: admins only. */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  req.user = await loadUser(req);
  if (!req.user) return reply.code(401).send({ error: 'login required' });
  if (req.user.role !== 'admin') return reply.code(403).send({ error: 'admin role required' });
}

export const isAdmin = (req: FastifyRequest) => req.user?.role === 'admin';

/** True when the user sees every workspace (admins, and viewers with "all communities"). */
const seesAllWorkspaces = (req: FastifyRequest) => isAdmin(req) || req.user?.allWorkspaces !== false;

/** Filter limiting documents to the workspaces (communities) the user may see. `field` holds the workspace id. */
export function workspaceFilter(req: FastifyRequest, field = 'workspace_id'): Document {
  if (seesAllWorkspaces(req)) return {};
  return { [field]: { $in: req.user!.workspaceIds } };
}

/** Whether the user may see one workspace (for routes addressed by workspace id). */
export function canSeeWorkspace(req: FastifyRequest, workspaceId: string): boolean {
  return seesAllWorkspaces(req) || req.user!.workspaceIds.includes(workspaceId);
}

/** Workspace ids the user may see, or null for all of them. Re-read from the database (for long-lived streams). */
export async function visibleWorkspaceIds(req: FastifyRequest): Promise<Set<string> | null> {
  if (seesAllWorkspaces(req)) return null;
  const u = await col.appUsers.findOne({ id: req.user!.id }, { projection: { all_workspaces: 1, workspace_ids: 1 } });
  if (u && u.all_workspaces !== false) return null;
  return new Set<string>(u?.workspace_ids ?? []);
}

/**
 * Filter hiding admin-hidden conversations and communities the user has no access to, for documents that carry
 * workspace_id and channel_id (messages, files, channel_accounts). Admins see everything.
 */
export async function visibleFilter(req: FastifyRequest): Promise<Document> {
  if (isAdmin(req)) return {};
  const hidden = await col.channels.find({ is_hidden: true }, { projection: { _id: 0, workspace_id: 1, id: 1 } }).toArray();
  const f: Document = { ...workspaceFilter(req) };
  if (hidden.length) f.$nor = hidden.map((h) => ({ workspace_id: h.workspace_id, channel_id: h.id }));
  return f;
}

/** Filter for the channels collection itself (its own id field is `id`). */
export function visibleChannelFilter(req: FastifyRequest): Document {
  if (isAdmin(req)) return {};
  return { ...workspaceFilter(req), is_hidden: { $ne: true } };
}

/**
 * Whether an account (accounts document, or null when there is none) is visible to this user — not hidden from
 * all viewers, and granted to this user when they only see selected accounts. A missing account passes.
 */
export function accountVisible(req: FastifyRequest, a: { workspace_id: string; user_id: string; is_hidden?: boolean } | null | undefined): boolean {
  if (isAdmin(req) || !a) return true;
  if (a.is_hidden) return false;
  if (req.user?.allAccounts !== false) return true;
  return req.user.accountGrants.some((g) => g.workspaceId === a.workspace_id && g.accountId === a.user_id);
}

/** Stands in for an account a viewer may not browse as: matches no channel_accounts row, so results come back empty. */
const NO_ACCOUNT = '#hidden-account'; // never a Slack user id

/**
 * The `accountId` filter to use for this request. Viewers asking to "view as" an account an admin hid get a
 * placeholder that matches nothing (empty results) instead of silently falling back to all accounts.
 */
export async function viewableAccountId(req: FastifyRequest, accountId: string | null | undefined): Promise<string | null> {
  if (!accountId) return null;
  if (isAdmin(req)) return accountId;
  const accounts = await col.accounts.find({ user_id: accountId }).toArray();
  return accounts.some((a) => !accountVisible(req, a as never)) ? NO_ACCOUNT : accountId;
}

/** Restricts documents with workspace_id/channel_id to conversations the given account can see. */
export async function accountScopeFilter(accountId: string): Promise<Document> {
  const links = await col.channelAccounts
    .find({ account_user_id: accountId }, { projection: { _id: 0, workspace_id: 1, channel_id: 1 } })
    .toArray();
  if (!links.length) return { _id: { $exists: false } }; // matches nothing
  const byWs = new Map<string, string[]>();
  for (const l of links) byWs.set(l.workspace_id, [...(byWs.get(l.workspace_id) ?? []), l.channel_id]);
  return { $or: [...byWs].map(([ws, ids]) => ({ workspace_id: ws, channel_id: { $in: ids } })) };
}

/** AND of several filters, dropping empty ones. */
export function and(...filters: Document[]): Document {
  const parts = filters.filter((f) => Object.keys(f).length);
  return parts.length === 0 ? {} : parts.length === 1 ? parts[0] : { $and: parts };
}

export async function audit(req: FastifyRequest, action: string, target: string | null, details?: Record<string, unknown>): Promise<void> {
  await col.auditLog.insertOne({
    id: await nextId('audit_log'),
    user_id: req.user?.id ?? null,
    user_email: req.user?.email ?? null,
    action,
    target,
    details: details ?? null,
    created_at: new Date(),
  });
}
