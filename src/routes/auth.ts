import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, createSession, destroySession, hashPassword, loadUser, publicUser, requireUser, toSessionUser, verifyPassword } from '../auth.js';
import { col, isDuplicateKey, nextId } from '../db/mongo.js';

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
    return { needsSetup: !(await col.appUsers.findOne({}, { projection: { _id: 1 } })) };
  });

  /** Creates the first admin. Only works while there are no users at all. */
  app.post('/setup', async (req, reply) => {
    const body = setupBody.parse(req.body);
    const hash = await hashPassword(body.password);
    // Only while there are no users at all. Two racing setups: the unique email index or the re-check stops the second.
    if (await col.appUsers.findOne({})) return reply.code(409).send({ error: 'setup already done' });
    const now = new Date();
    const doc = {
      id: await nextId('app_users'),
      email: body.email,
      name: body.name || null,
      password_hash: hash,
      role: 'admin',
      is_active: true,
      last_login_at: null,
      all_workspaces: true,
      all_accounts: true,
      workspace_ids: [],
      account_grants: [],
      created_at: now,
      updated_at: now,
    };
    try {
      await col.appUsers.insertOne(doc);
    } catch (err) {
      if (isDuplicateKey(err)) return reply.code(409).send({ error: 'setup already done' });
      throw err;
    }
    if ((await col.appUsers.countDocuments({})) > 1) {
      await col.appUsers.deleteOne({ id: doc.id });
      return reply.code(409).send({ error: 'setup already done' });
    }
    req.user = toSessionUser(doc);
    await audit(req, 'auth.setup', String(doc.id));
    await createSession(req, reply, doc.id);
    return { ok: true };
  });

  app.post('/login', async (req, reply) => {
    const body = loginBody.parse(req.body);
    const f = failures.get(req.ip);
    if (f && f.count >= LOCK_AFTER && f.until > Date.now()) {
      return reply.code(429).send({ error: 'too many failed attempts, try again later' });
    }
    const u = await col.appUsers.findOne({ email: body.email });
    const ok = u && u.is_active && (await verifyPassword(body.password, u.password_hash));
    if (!ok) {
      const next = { count: (f && f.until > Date.now() ? f.count : 0) + 1, until: Date.now() + LOCK_MS };
      failures.set(req.ip, next);
      return reply.code(401).send({ error: 'wrong email or password' });
    }
    failures.delete(req.ip);
    req.user = toSessionUser(u!);
    await createSession(req, reply, Number(u!.id));
    await audit(req, 'auth.login', String(u!.id));
    return { ok: true };
  });

  app.post('/logout', async (req, reply) => {
    await destroySession(req, reply);
    return { ok: true };
  });

  app.get('/me', async (req, reply) => {
    const user = await loadUser(req);
    if (!user) return reply.code(401).send({ error: 'login required' });
    return publicUser(user);
  });

  app.post('/password', { onRequest: requireUser }, async (req, reply) => {
    const body = passwordBody.parse(req.body);
    const u = await col.appUsers.findOne({ id: req.user!.id });
    if (!u || !(await verifyPassword(body.currentPassword, u.password_hash))) {
      return reply.code(400).send({ error: 'current password is wrong' });
    }
    await col.appUsers.updateOne({ id: req.user!.id }, { $set: { password_hash: await hashPassword(body.newPassword), updated_at: new Date() } });
    await audit(req, 'auth.password_change', String(req.user!.id));
    return { ok: true };
  });
}
