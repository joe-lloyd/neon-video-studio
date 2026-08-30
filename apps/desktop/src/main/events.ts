/**
 * Central event hub: every notable action becomes an ActivityEntry that is
 *   • pushed to the renderer (RPC message → live activity panel + clip flashes),
 *   • streamed to CLI/agents over Server-Sent Events (GET /api/events),
 *   • kept in a short ring buffer so late subscribers get recent history.
 */
import { newId, type ActivityEntry, type ActivitySource, type ServerEvent } from '@neon/core';

type Subscriber = (event: ServerEvent) => void;

export class EventHub {
  private readonly subscribers = new Set<Subscriber>();
  private readonly history: ActivityEntry[] = [];
  private readonly maxHistory = 200;

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  recent(limit = 50): ActivityEntry[] {
    return this.history.slice(-limit);
  }

  emit(event: ServerEvent): void {
    for (const fn of this.subscribers) {
      try {
        fn(event);
      } catch (err) {
        console.error('[events] subscriber failed', err);
      }
    }
  }

  activity(source: ActivitySource, action: string, message: string, refs: Partial<Pick<ActivityEntry, 'clipIds' | 'trackIds' | 'assetIds' | 'jobId'>> = {}): ActivityEntry {
    const entry: ActivityEntry = { id: newId('act'), ts: new Date().toISOString(), source, action, message, ...refs };
    this.history.push(entry);
    if (this.history.length > this.maxHistory) this.history.splice(0, this.history.length - this.maxHistory);
    console.log(`[activity] ${source} ${action}: ${message}`);
    this.emit({ type: 'activity', entry });
    return entry;
  }
}

/** Encode one SSE frame. */
export function sseFrame(event: ServerEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
