import { EventEmitter } from 'node:events';

export interface MessagesIngestedEvent {
  workspaceId: string;
  channelId: string;
  channelName: string;
  inserted: number;
  updated: number;
  newestTs: string | null;
}

/** Desktop apps of these users (null = everyone) should check in now: new notification, update or server policy. */
export interface AppPingEvent {
  userIds: number[] | null;
}

export interface SyncRunEvent {
  id: string;
  status: string;
}

/** New messages from live capture (any channel, DM or thread), shown as toasts / desktop notifications. */
export interface NotificationEvent {
  workspaceId: string;
  workspaceName: string | null;
  workspaceIconUrl: string | null;
  channelId: string;
  channelName: string;
  channelType: string;
  channelHidden: boolean; // admin-hidden conversations only reach admins
  /** Slack account whose browser captured these messages. */
  accountId: string | null;
  messages: {
    ts: string;
    threadTs: string | null;
    userId: string | null;
    userName: string | null;
    avatarUrl: string | null;
    isBot: boolean;
    text: string;
    fileCount: number;
  }[];
}

/** In-process bus feeding the SSE stream (/api/stream). */
class Bus extends EventEmitter {
  emitNotification(e: NotificationEvent) {
    this.emit('notification', e);
  }
  emitMessages(e: MessagesIngestedEvent) {
    this.emit('messages', e);
  }
  emitSyncRun(e: SyncRunEvent) {
    this.emit('sync_run', e);
  }
  emitAppPing(e: AppPingEvent) {
    this.emit('app_ping', e);
  }
}

export const bus = new Bus();
bus.setMaxListeners(100);
