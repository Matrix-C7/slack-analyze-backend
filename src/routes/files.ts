import type { FastifyInstance } from 'fastify';
import { requireUser, visibleSql } from '../auth.js';
import { pool } from '../db/pool.js';
import { type ByteRange, fileStore } from '../services/fileStore.js';

/** Types a browser would run as a page or script if opened inline: always served as a download. */
const ACTIVE_CONTENT = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml|text\/javascript|application\/javascript)/i;

function parseRange(header: string | undefined, size: number): ByteRange | 'invalid' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim()); // single ranges only; multipart ranges are rarely used
  if (!m || (!m[1] && !m[2])) return 'invalid';
  let start: number;
  let end: number;
  if (!m[1]) {
    start = Math.max(0, size - Number(m[2])); // suffix: last N bytes
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  return start > end || start >= size ? 'invalid' : { start, end };
}

/** RFC 6266 filename, with an ASCII fallback for old clients. */
function disposition(type: 'inline' | 'attachment', name: string) {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Archived Slack files, for logged-in dashboard users who can see the message they belong to. */
export async function fileRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireUser);

  app.get<{ Params: { id: string }; Querystring: { download?: string } }>('/files/:id/content', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid file id' });
    const { rows } = await pool.query(
      `SELECT f.name, COALESCE(b.mime_type, f.mime_type) AS mime_type, b.sha256, b.size_bytes, b.storage, b.storage_key
       FROM message_files f
       JOIN messages m ON m.id = f.message_id
       JOIN file_blobs b ON b.sha256 = f.blob_sha256
       WHERE f.id = $1 AND f.status = 'stored' AND ${visibleSql(req, 'm.workspace_id', 'm.channel_id')}`,
      [id],
    );
    const f = rows[0];
    if (!f) return reply.code(404).send({ error: 'file not archived' });
    if (f.storage !== fileStore.name) {
      return reply.code(503).send({ error: `file is kept in "${f.storage}" storage, but the server runs with FILE_STORAGE=${fileStore.name}` });
    }

    const etag = `"${f.sha256}"`;
    const mimeType: string = f.mime_type || 'application/octet-stream';
    const size = Number(f.size_bytes);
    const asDownload = req.query.download === '1' || ACTIVE_CONTENT.test(mimeType);

    reply
      .header('ETag', etag)
      // Content-addressed: the bytes behind this URL never change. private: it is behind a login.
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .header('Accept-Ranges', 'bytes')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', disposition(asDownload ? 'attachment' : 'inline', f.name || `file-${id}`));
    // Belt and braces for anything opened directly: no scripts. PDFs are exempt (Chrome's viewer needs to run).
    if (!/^application\/pdf/i.test(mimeType)) reply.header('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'");

    if (req.headers['if-none-match'] === etag) return reply.code(304).send();

    const range = parseRange(req.headers.range, size);
    if (range === 'invalid') return reply.code(416).header('Content-Range', `bytes */${size}`).send();

    let stream;
    try {
      stream = await fileStore.get(f.storage_key, range ?? undefined);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        req.log.error({ sha256: f.sha256 }, 'archived file missing from storage');
        return reply.code(410).send({ error: 'file missing from storage' });
      }
      throw err;
    }
    reply.type(mimeType);
    if (range) {
      reply.code(206).header('Content-Range', `bytes ${range.start}-${range.end}/${size}`).header('Content-Length', range.end - range.start + 1);
    } else {
      reply.header('Content-Length', size);
    }
    return reply.send(stream);
  });
}
