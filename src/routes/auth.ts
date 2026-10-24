import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, createSession, destroySession, hashPassword, loadUser, requireUser, verifyPassword } from '../auth.js';
import { pool } from '../db/pool.js';

export const passwordSchema = z.string().min(8, 'at least 8 characters').max(200);
const emailSchema = z.string().trim().toLowerCase().email().max(200);

const loginBody = z.object({ email: emailSchema, password: z.string().min(1).max(200) });
const setupBody = z.object({ email: emailSchema, name: z.string().trim().max(200).optional(), password: passwordSchema });
const passwordBody = z.object({ currentPassword: z.string().min(1), newPassword: passwordSchema });

// Simple brute-force brake: after 10 failures from one IP, refuse logins for 15 minutes.
const failures = new Map<string, { count: number; until: number }>();
const LOCK_AFTER = 10;
const LOCK_MS = 15 * 60_000;

/** Login / logout / first-run setup for the dashboard. */
export async function authRoutes(app: FastifyInstance) {
  /** Tells the login page whether to show "create the first admin" instead of "sign in". */
  app.get('/status', async () => {
    const { rows } = await pool.query('SELECT count(*) AS n FROM app_users');
    return { needsSetup: rows[0].n === 0 };
  });

  /** Creates the first admin. Only works while there are no users at all. */
  app.post('/setup', async (req, reply) => {
    const body = setupBody.parse(req.body);
    const hash = await hashPassword(body.password);
    const { rows } = await pool.query(
      `INSERT INTO app_users (email, name, password_hash, role)
       SELECT $1, $2, $3, 'admin' WHERE NOT EXISTS (SELECT 1 FROM app_users)
       RETURNING id, email`,
      [body.email, body.name || null, hash],
    );
    if (!rows[0]) return reply.code(409).send({ error: 'setup already done' });
    req.user = { id: Number(rows[0].id), email: rows[0].email, name: body.name || null, role: 'admin', allWorkspaces: true, allAccounts: true };
    await audit(req, 'auth.setup', String(rows[0].id));
    await createSession(req, reply, Number(rows[0].id));
    return { ok: true };
  });

  app.post('/login', async (req, reply) => {
    const body = loginBody.parse(req.body);
    const f = failures.get(req.ip);
    if (f && f.count >= LOCK_AFTER && f.until > Date.now()) {
      return reply.code(429).send({ error: 'too many failed attempts, try again later' });
    }
    const { rows } = await pool.query('SELECT id, email, name, role, password_hash, is_active FROM app_users WHERE lower(email) = $1', [
      body.email,
    ]);
    const u = rows[0];
    const ok = u && u.is_active && (await verifyPassword(body.password, u.password_hash));
    if (!ok) {
      const next = { count: (f && f.until > Date.now() ? f.count : 0) + 1, until: Date.now() + LOCK_MS };
      failures.set(req.ip, next);
      return reply.code(401).send({ error: 'wrong email or password' });
    }
    failures.delete(req.ip);
    req.user = { id: Number(u.id), email: u.email, name: u.name, role: u.role, allWorkspaces: u.all_workspaces, allAccounts: u.all_accounts };
    await createSession(req, reply, Number(u.id));
    await audit(req, 'auth.login', String(u.id));
    return { ok: true };
  });

  app.post('/logout', async (req, reply) => {
    await destroySession(req, reply);
    return { ok: true };
  });

  app.get('/me', async (req, reply) => {
    const user = await loadUser(req);
    if (!user) return reply.code(401).send({ error: 'login required' });
    return user;
  });

  app.post('/password', { onRequest: requireUser }, async (req, reply) => {
    const body = passwordBody.parse(req.body);
    const { rows } = await pool.query('SELECT password_hash FROM app_users WHERE id = $1', [req.user!.id]);
    if (!(await verifyPassword(body.currentPassword, rows[0].password_hash))) {
      return reply.code(400).send({ error: 'current password is wrong' });
    }
    await pool.query('UPDATE app_users SET password_hash = $2, updated_at = now() WHERE id = $1', [
      req.user!.id,
      await hashPassword(body.newPassword),
    ]);
    await audit(req, 'auth.password_change', String(req.user!.id));
    return { ok: true };
  });
}
