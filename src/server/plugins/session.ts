import type {FastifyInstance, Session} from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifySession from '@fastify/session';
import {eq, lt} from 'drizzle-orm';
import type {Database} from '../db/index.js';
import {sessions} from '../db/schema.js';
import type {AppConfig} from '../config.js';

declare module 'fastify' {
  interface Session {
    /** Set once a user registers or logs in; absent for anonymous sessions. */
    userId?: string;
  }
}

export const SESSION_COOKIE_NAME = 'sessionId';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

type StoreCallback = (err?: unknown) => void;
type GetCallback = (err: unknown, session?: Session | null) => void;

/**
 * A `@fastify/session` store backed by the `sessions` table (see `db/schema.ts`). Session
 * rows carry a `user_id` foreign key (NOT NULL), so only sessions that have a `userId` set
 * (i.e. a logged-in user) are ever persisted — anonymous sessions are never written, which
 * pairs with `saveUninitialized: false` on the session plugin itself.
 */
export class SqliteSessionStore {
  private readonly db: Database;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(db: Database) {
    this.db = db;
    this.timer = setInterval(() => this.pruneExpired(), PRUNE_INTERVAL_MS);
    this.timer.unref();
  }

  set(sessionId: string, session: Session, callback: StoreCallback): void {
    try {
      const userId = session.userId;
      if (!userId) {
        // Nothing to persist yet (no logged-in user) — the FK requires one.
        callback();
        return;
      }

      const expiresAt = session.cookie.expires ? new Date(session.cookie.expires).getTime() : Date.now() + THIRTY_DAYS_MS;
      const data = JSON.stringify(session);

      this.db
        .insert(sessions)
        .values({sid: sessionId, userId, data, expiresAt})
        .onConflictDoUpdate({target: sessions.sid, set: {userId, data, expiresAt}})
        .run();
      callback();
    } catch (err) {
      callback(err);
    }
  }

  get(sessionId: string, callback: GetCallback): void {
    try {
      const row = this.db.select().from(sessions).where(eq(sessions.sid, sessionId)).get();
      if (!row) {
        callback(null, null);
        return;
      }
      if (row.expiresAt <= Date.now()) {
        this.destroy(sessionId, () => callback(null, null));
        return;
      }
      callback(null, JSON.parse(row.data) as Session);
    } catch (err) {
      callback(err);
    }
  }

  destroy(sessionId: string, callback: StoreCallback): void {
    try {
      this.db.delete(sessions).where(eq(sessions.sid, sessionId)).run();
      callback();
    } catch (err) {
      callback(err);
    }
  }

  /** Deletes expired session rows. Called on an hourly timer; also safe to call directly. */
  pruneExpired(): void {
    this.db.delete(sessions).where(lt(sessions.expiresAt, Date.now())).run();
  }

  /** Stops the prune timer. The timer is unref'd so this isn't required for process exit,
   * but tests/`app.close()` call it to avoid leaking timers across test runs. */
  close(): void {
    clearInterval(this.timer);
  }
}

/**
 * Registers `@fastify/cookie` and `@fastify/session`, wired to `SqliteSessionStore`.
 * Cookie is HttpOnly, SameSite=Lax, secure only over https (per `config.publicUrl`), with
 * a 30-day rolling lifetime.
 */
export async function registerSessionPlugin(app: FastifyInstance, config: AppConfig): Promise<void> {
  const store = new SqliteSessionStore(app.db);
  app.addHook('onClose', () => store.close());

  await app.register(fastifyCookie);
  await app.register(fastifySession, {
    secret: config.sessionSecret,
    cookieName: SESSION_COOKIE_NAME,
    saveUninitialized: false,
    rolling: true,
    store,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.publicUrl.toLowerCase().startsWith('https'),
      maxAge: THIRTY_DAYS_MS,
      path: '/',
    },
  });
}
