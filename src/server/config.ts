export interface AppConfig {
  port: number;
  databasePath: string;
  sessionSecret: string;
  publicUrl: string;
  nodeEnv: string;
}

const DEV_SESSION_SECRET = 'dev-only-session-secret-do-not-use-in-production!!';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const port = env.PORT ? Number(env.PORT) : 3000;
  const databasePath = env.DATABASE_PATH ?? './data/agent-jira.db';

  let sessionSecret = env.SESSION_SECRET;
  if (!sessionSecret || sessionSecret.length < 32) {
    if (nodeEnv === 'production') {
      throw new Error('SESSION_SECRET must be set to a string of at least 32 characters in production');
    }
    sessionSecret = DEV_SESSION_SECRET;
  }

  const publicUrl = env.PUBLIC_URL ?? `http://localhost:${port}`;

  return {port, databasePath, sessionSecret, publicUrl, nodeEnv};
}
