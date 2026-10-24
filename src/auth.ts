import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { config } from './config.js';
import { pool } from './db/pool.js';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export const SESSION_COOKIE = 'sa_session';
const SESSION_DAYS = 14;

export type Role = 'admin' | 'viewer';

export interface SessionUser {
  id: number;
  email: string;
  name: string | null;
  role: Role;
  /** false: only the workspaces granted in app_user_workspaces are visible (ignored for admins). */
  allWorkspaces: boolean;
  /** false: only the Slack accounts granted in app_user_accounts are visible (ignored for admins). */
  allAccounts: boolean;
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

export async function createSession(req: FastifyRequest, reply: FastifyReply, userId: number): Promise<void> {
  const token = crypto.randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO app_sessions (token_hash, user_id, user_agent, ip, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(days => $5))`,
    [sha256(token), userId, req.headers['user-agent']?.slice(0, 300) ?? null, req.ip, SESSION_DAYS],
  );
  await pool.query('UPDATE app_users SET last_login_at = now() WHERE id = $1', [userId]);
  reply.header('Set-Cookie', cookieHeader(token, SESSION_DAYS * 86400));
}

export async function destroySession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) await pool.query('DELETE FROM app_sessions WHERE token_hash = $1', [sha256(token)]);
  reply.header('Set-Cookie', cookieHeader('', 0));
}

/** Resolves the session cookie to an active user (or undefined). */
export async function loadUser(req: FastifyRequest): Promise<SessionUser | undefined> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return undefined;
  const { rows } = await pool.query(
    `UPDATE app_sessions s SET last_used_at = now()
     FROM app_users u
     WHERE s.token_hash = $1 AND s.expires_at > now() AND u.id = s.user_id AND u.is_active
     RETURNING u.id, u.email, u.name, u.role, u.all_workspaces, u.all_accounts`,
    [sha256(token)],
  );
  const r = rows[0];
  return r
    ? { id: Number(r.id), email: r.email, name: r.name, role: r.role, allWorkspaces: r.all_workspaces, allAccounts: r.all_accounts }
    : undefined;
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

/**
 * SQL condition limiting rows to the workspaces (communities) the user may see. `ws` is the SQL expression for
 * the workspace id (e.g. "m.workspace_id"). The user id is a number from the session, so inlining it is safe.
 */
export function workspaceSql(req: FastifyRequest, ws: string): string {
  if (seesAllWorkspaces(req)) return 'true';
  return `${ws} IN (SELECT aw.workspace_id FROM app_user_workspaces aw WHERE aw.user_id = ${Number(req.user!.id)})`;
}

/** Whether the user may see one workspace (for routes addressed by workspace id). */
export async function canSeeWorkspace(req: FastifyRequest, workspaceId: string): Promise<boolean> {
  if (seesAllWorkspaces(req)) return true;
  const { rowCount } = await pool.query('SELECT 1 FROM app_user_workspaces WHERE user_id = $1 AND workspace_id = $2', [
    req.user!.id,
    workspaceId,
  ]);
  return Boolean(rowCount);
}

/** Workspace ids the user may see, or null for all of them. */
export async function visibleWorkspaceIds(req: FastifyRequest): Promise<Set<string> | null> {
  if (seesAllWorkspaces(req)) return null;
  const { rows } = await pool.query('SELECT workspace_id FROM app_user_workspaces WHERE user_id = $1', [req.user!.id]);
  return new Set(rows.map((r) => r.workspace_id as string));
}

/**
 * SQL condition hiding admin-hidden conversations and communities the user has no access to. `ws` / `ch` are the
 * SQL expressions for the workspace and channel id (e.g. "m.workspace_id", "m.channel_id"). Admins see everything.
 */
export function visibleSql(req: FastifyRequest, ws: string, ch: string): string {
  if (isAdmin(req)) return 'true';
  return `${workspaceSql(req, ws)} AND NOT EXISTS (SELECT 1 FROM channels hc WHERE hc.workspace_id = ${ws} AND hc.id = ${ch} AND hc.is_hidden)`;
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
  const { rowCount } = await pool.query(`SELECT 1 FROM accounts a WHERE a.user_id = $1 AND NOT (${accountVisibleSql(req)})`, [accountId]);
  return rowCount ? NO_ACCOUNT : accountId;
}

/**
 * SQL condition: the account alias `a` (accounts, possibly from a LEFT JOIN) is visible to this user — not hidden
 * from all viewers, and granted to this user when they only see selected accounts. Rows with no account pass.
 * The user id is a number from the session, so inlining it is safe.
 */
export function accountVisibleSql(req: FastifyRequest, alias = 'a'): string {
  if (isAdmin(req)) return 'true';
  const notHidden = `${alias}.is_hidden IS NOT TRUE`;
  if (req.user?.allAccounts !== false) return notHidden;
  return `(${alias}.user_id IS NULL OR (${notHidden} AND EXISTS (
    SELECT 1 FROM app_user_accounts ua
    WHERE ua.user_id = ${Number(req.user.id)} AND ua.workspace_id = ${alias}.workspace_id AND ua.account_user_id = ${alias}.user_id)))`;
}

export async function audit(
  req: FastifyRequest,
  action: string,
  target: string | null,
  details?: Record<string, unknown>,
  db: pg.Pool | pg.PoolClient = pool,
): Promise<void> {
  await db.query('INSERT INTO audit_log (user_id, user_email, action, target, details) VALUES ($1, $2, $3, $4, $5)', [
    req.user?.id ?? null,
    req.user?.email ?? null,
    action,
    target,
    details ?? null,
  ]);
}
