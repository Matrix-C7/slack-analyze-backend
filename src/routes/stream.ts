import { isAdmin, requireUser, visibleWorkspaceIds } from '../auth.js';
import type { FastifyInstance } from 'fastify';
import { bus, type MessagesIngestedEvent, type NotificationEvent, type SyncRunEvent } from '../events.js';

/** Server-Sent Events: pushes ingest activity to open frontend tabs so views refresh live. */
export async function streamRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireUser);

  app.get('/stream', async (req, reply) => {
    // Viewers limited to some communities only get events for those; re-read periodically so access changes apply.
    let allowed = await visibleWorkspaceIds(req);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': req.headers.origin ?? '*',
      'Access-Control-Allow-Credentials': 'true',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const onMessages = (e: MessagesIngestedEvent) => (!allowed || allowed.has(e.workspaceId)) && send('messages', e);
    const onRun = (e: SyncRunEvent) => send('sync_run', e);
    // Same rules as reading the conversation: community access, and admin-hidden conversations for admins only.
    const admin = isAdmin(req);
    const onNotification = (e: NotificationEvent) => {
      if (allowed && !allowed.has(e.workspaceId)) return;
      if (e.channelHidden && !admin) return;
      const { channelHidden: _hidden, ...data } = e;
      send('notification', data);
    };
    const heartbeat = setInterval(() => {
      res.write(': ping\n\n');
      visibleWorkspaceIds(req).then((ids) => (allowed = ids), () => {});
    }, 25_000);

    bus.on('messages', onMessages);
    bus.on('sync_run', onRun);
    bus.on('notification', onNotification);
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      bus.off('messages', onMessages);
      bus.off('sync_run', onRun);
      bus.off('notification', onNotification);
    });
  });
}
