export interface AppConfig {
  port: number;
  databasePath: string;
  sessionSecret: string;
  publicUrl: string;
  nodeEnv: string;
  trustProxy: boolean;
}

const DEV_SESSION_SECRET = 'dev-only-session-secret-do-not-use-in-production!!';

/**
 * Catches a secret that was never actually replaced. `.env.example`'s placeholder is
 * checked into this repo, so it is public — and, at 54 characters, long enough to sail
 * past the length check below. A deployer who runs `cp .env.example .env` (this app's own
 * README quickstart, step one) and skips the next step must not be able to boot production
 * with it. The prefix check also catches any other "change-me"/"changeme"-style value a
 * deployer might type as a stand-in and forget to replace, not just this exact string.
 */
function isPlaceholderSecret(secret: string): boolean {
  return /^change-?me/i.test(secret);
}

const SESSION_SECRET_HELP = 'Generate one with: openssl rand -hex 32';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';

  let port = 3000;
  if (env.PORT !== undefined && env.PORT !== '') {
    const parsedPort = Number(env.PORT);
    if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
      throw new Error(`PORT must be a positive integer between 1 and 65535, got: ${JSON.stringify(env.PORT)}`);
    }
    port = parsedPort;
  }

  const databasePath = env.DATABASE_PATH ?? './data/agent-jira.db';

  const rawSessionSecret = env.SESSION_SECRET;
  const isMissingOrShort = !rawSessionSecret || rawSessionSecret.length < 32;
  const isPlaceholder = rawSessionSecret !== undefined && isPlaceholderSecret(rawSessionSecret);
  let sessionSecret: string;
  if (isMissingOrShort || isPlaceholder) {
    if (nodeEnv === 'production') {
      const reason = isPlaceholder
        ? 'SESSION_SECRET is still set to a placeholder value'
        : 'SESSION_SECRET must be set to a string of at least 32 characters';
      throw new Error(`${reason} in production. ${SESSION_SECRET_HELP}`);
    }
    sessionSecret = DEV_SESSION_SECRET;
  } else {
    sessionSecret = rawSessionSecret;
  }

  const publicUrl = env.PUBLIC_URL ?? `http://localhost:${port}`;

  // Off by default: trusting `X-Forwarded-*` headers from a client that is not actually
  // behind a reverse proxy lets that client forge its own IP and dodge every per-IP rate
  // limit (see `oauthRoutes`'s registration limiter). Only a deployer who has actually put
  // a proxy in front of this server should opt in.
  const trustProxy = env.TRUST_PROXY === 'true' || env.TRUST_PROXY === '1';

  return {port, databasePath, sessionSecret, publicUrl, nodeEnv, trustProxy};
}
