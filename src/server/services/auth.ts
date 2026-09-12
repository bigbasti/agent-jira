import type {FastifyReply, FastifyRequest} from 'fastify';
import {eq} from 'drizzle-orm';
import {nanoid} from 'nanoid';
import {hash, verify} from '@node-rs/argon2';
import {z} from 'zod';
import type {Database} from '../db/index.js';
import {users} from '../db/schema.js';
import type {User} from '../../shared/types.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireUser` once a session's `userId` resolves to a real user. */
    user?: {id: string; email: string};
  }
}

export class ConflictError extends Error {
  constructor(message = 'Resource already exists') {
    super(message);
    this.name = 'ConflictError';
  }
}

export const credentialsSchema = z.object({
  // trim/lowercase must run before the `.email()` format check, or an untrimmed address
  // with mixed case (e.g. from a form) fails validation before normalization applies.
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(12).max(200),
});

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as {code?: unknown}).code === 'SQLITE_CONSTRAINT_UNIQUE';
}

function toUser(row: {id: string; email: string; createdAt: number}): User {
  return {id: row.id, email: row.email, createdAt: row.createdAt};
}

function findUserByEmail(db: Database, email: string) {
  return db.select().from(users).where(eq(users.email, email)).get();
}

function findUserById(db: Database, id: string) {
  return db.select().from(users).where(eq(users.id, id)).get();
}

// A hash of an unguessable password, computed lazily and cached. `verifyUser` runs
// `verify()` against this when no user exists for the supplied email, so an
// unknown-email login costs the same argon2 verification work (and returns the same
// response) as a wrong-password login — it can't be used to enumerate accounts.
let dummyHashPromise: Promise<string> | undefined;
function getDummyHash(): Promise<string> {
  dummyHashPromise ??= hash(nanoid(32));
  return dummyHashPromise;
}

/**
 * Registers a new user. `input` is validated with `credentialsSchema` (throws `ZodError`
 * on an invalid shape/short password) and throws `ConflictError` if the (normalized) email
 * is already taken.
 */
export async function registerUser(db: Database, input: unknown): Promise<User> {
  const {email, password} = credentialsSchema.parse(input);
  const passwordHash = await hash(password);
  const row = {id: nanoid(), email, passwordHash, createdAt: Date.now()};

  try {
    db.insert(users).values(row).run();
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new ConflictError('Email already registered');
    }
    throw err;
  }

  return toUser(row);
}

/**
 * Verifies email/password credentials. Returns `null` for both an unknown email and a
 * wrong password — callers must not distinguish the two in their response.
 */
export async function verifyUser(db: Database, input: unknown): Promise<User | null> {
  const {email, password} = credentialsSchema.parse(input);
  const row = findUserByEmail(db, email);
  const hashToVerify = row ? row.passwordHash : await getDummyHash();
  const valid = await verify(hashToVerify, password);

  if (!row || !valid) {
    return null;
  }
  return toUser(row);
}

/**
 * Fastify preHandler guard: 401s with `{error: 'unauthorized'}` when there is no session
 * or the session's user no longer exists; otherwise sets `req.user = {id, email}`.
 */
export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  const userId = req.session.userId;
  if (!userId) {
    return reply.code(401).send({error: 'unauthorized'});
  }

  const row = findUserById(req.server.db, userId);
  if (!row) {
    return reply.code(401).send({error: 'unauthorized'});
  }

  req.user = {id: row.id, email: row.email};
}
