import type { FastifyInstance } from 'fastify';
import { Binary } from 'mongodb';
import { z } from 'zod';
import { audit, createSession, destroySession, hashPassword, loadUser, publicUser, requireUser, toSessionUser, verifyPassword } from '../auth.js';
import { col, isDuplicateKey, nextId } from '../db/mongo.js';

export const passwordSchema = z.string().min(8, 'at least 8 characters').max(200);
const emailSchema = z.string().trim().toLowerCase().email().max(200);

const loginBody = z.object({ email: emailSchema, password: z.string().min(1).max(200) });
const setupBody = z.object({ email: emailSchema, name: z.string().trim().max(200).optional(), password: passwordSchema });
const passwordBody = z.object({ currentPassword: z.string().min(1), newPassword: passwordSchema });

const AVATAR_MAX_BYTES = 512 * 1024;
const avatarBody = z.object({
  type: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  data: z.string().min(1).max(Math.ceil((AVATAR_MAX_BYTES * 4) / 3) + 8),
});

/** Checks the file signature matches the declared type. */
function looksLike(b: Buffer, type: string): boolean {
  if (type === 'image/png') return b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (type === 'image/jpeg') return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (type === 'image/webp') return b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP';
  return false;
}


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

  // ---------- profile photo ----------

  /** Upload / replace the signed-in user's photo: { type, data } with data = base64 (no data: prefix). Max 512 KB. */
  app.put('/avatar', { onRequest: requireUser }, async (req, reply) => {
    const body = avatarBody.parse(req.body);
    const bytes = Buffer.from(body.data, 'base64');
    if (bytes.length === 0 || bytes.length > AVATAR_MAX_BYTES) return reply.code(413).send({ error: 'photo must be 512 KB or smaller' });
    if (!looksLike(bytes, body.type)) return reply.code(400).send({ error: 'not a PNG, JPEG or WebP image' });
    const now = new Date();
    await col.appUsers.updateOne(
      { id: req.user!.id },
      { $set: { avatar: new Binary(bytes), avatar_type: body.type, avatar_updated_at: now, updated_at: now } },
    );
    await audit(req, 'auth.avatar_change', String(req.user!.id));
    return { ok: true, avatarVersion: now.getTime() };
  });

  /** Remove the signed-in user's photo (back to initials). */
  app.delete('/avatar', { onRequest: requireUser }, async (req) => {
    await col.appUsers.updateOne(
      { id: req.user!.id },
      { $unset: { avatar: '', avatar_type: '', avatar_updated_at: '' }, $set: { updated_at: new Date() } },
    );
    await audit(req, 'auth.avatar_remove', String(req.user!.id));
    return { ok: true };
  });

  /** A dashboard user's photo (any signed-in user may see it). Add ?v=<avatarVersion> to the URL; responses are cached. */
  app.get('/avatar/:id', { onRequest: requireUser }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad id' });
    const u = await col.appUsers.findOne({ id }, { projection: { avatar: 1, avatar_type: 1 } });
    if (!u?.avatar) return reply.code(404).send({ error: 'no photo' });
    const bytes: Buffer = u.avatar instanceof Binary ? Buffer.from(u.avatar.buffer) : Buffer.from(u.avatar);
    return reply
      .header('Content-Type', u.avatar_type ?? 'image/png')
      .header('Cache-Control', 'private, max-age=86400')
      .send(bytes);
  });
}

