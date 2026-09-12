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

  let port = 3000;
  if (env.PORT !== undefined && env.PORT !== '') {
    const parsedPort = Number(env.PORT);
    if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
      throw new Error(`PORT must be a positive integer between 1 and 65535, got: ${JSON.stringify(env.PORT)}`);
    }
    port = parsedPort;
  }

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
