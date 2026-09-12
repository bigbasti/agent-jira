import type {ServerEvent} from '../../shared/types.js';

type Subscriber = (event: ServerEvent) => void;

/**
 * A per-user, in-process pub/sub hub. Every browser tab (via the `/ws` route) and every
 * MCP long-poll (via `waitFor`) for a given user subscribes here; `publish` fans an event
 * out to that user's subscribers only — events never cross users.
 */
export class EventHub {
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  /** Settle callbacks for in-flight `waitFor` calls, so `close()` can resolve them all. */
  private readonly pendingWaits = new Set<(event: ServerEvent | null) => void>();
  /** Number of in-flight `waitFor` calls per user — read-only introspection for callers. */
  readonly waiters = new Map<string, number>();

  /** Subscribes `send` to `userId`'s events. Returns an idempotent unsubscribe function. */
  subscribe(userId: string, send: Subscriber): () => void {
    let set = this.subscribers.get(userId);
    if (!set) {
      set = new Set();
      this.subscribers.set(userId, set);
    }
    set.add(send);

    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      set!.delete(send);
      if (set!.size === 0) {
        this.subscribers.delete(userId);
      }
    };
  }

  /**
   * Delivers `event` to every current subscriber of `userId`. Iterates a snapshot of the
   * subscriber set inside a try/catch per subscriber, so one throwing subscriber (e.g. a
   * socket write that fails) cannot stop delivery to the others.
   */
  publish(userId: string, event: ServerEvent): void {
    const set = this.subscribers.get(userId);
    if (!set || set.size === 0) return;

    for (const send of [...set]) {
      try {
        send(event);
      } catch {
        // A broken subscriber must not prevent delivery to the rest.
      }
    }
  }

  /**
   * Parks until `predicate` matches an event published for `userId`, or `timeoutMs`
   * elapses — used by the MCP `wait_for_work` long-poll. Resolves to the matching event,
   * or `null` on timeout. Always cleans up its temporary subscriber and timer, on every
   * exit path: a match, a timeout, or the hub being closed.
   */
  waitFor(userId: string, predicate: (event: ServerEvent) => boolean, timeoutMs: number): Promise<ServerEvent | null> {
    return new Promise(resolve => {
      this.waiters.set(userId, (this.waiters.get(userId) ?? 0) + 1);

      let settled = false;
      const settle = (event: ServerEvent | null): void => {
        if (settled) return;
        settled = true;

        this.pendingWaits.delete(settle);
        unsubscribe();
        clearTimeout(timer);

        const remaining = (this.waiters.get(userId) ?? 1) - 1;
        if (remaining <= 0) {
          this.waiters.delete(userId);
        } else {
          this.waiters.set(userId, remaining);
        }

        resolve(event);
      };
      this.pendingWaits.add(settle);

      const unsubscribe = this.subscribe(userId, event => {
        if (predicate(event)) {
          settle(event);
        }
      });

      const timer = setTimeout(() => settle(null), timeoutMs);
      timer.unref();
    });
  }

  /**
   * Resolves every in-flight `waitFor` call to `null` and clears its subscriber/timer.
   * Call this on app shutdown so a parked MCP long-poll never hangs forever.
   */
  close(): void {
    for (const settle of [...this.pendingWaits]) {
      settle(null);
    }
  }

  /** Number of active subscribers for `userId` — exposed so tests can verify a socket's
   * subscription is actually removed on unsubscribe/close, not just externally silent.
   * Test-only introspection; not used by production code. Includes temporary `waitFor`
   * subscribers (each `waitFor` call subscribes for the duration of its wait), not just
   * long-lived ones like websocket connections. */
  subscriberCount(userId: string): number {
    return this.subscribers.get(userId)?.size ?? 0;
  }
}
