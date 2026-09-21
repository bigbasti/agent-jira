import {sqliteTable, text, integer, index, primaryKey, type AnySQLiteColumn} from 'drizzle-orm/sqlite-core';
import {STATUSES} from '../../shared/status.js';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, {onDelete: 'cascade'}),
    name: text('name').notNull(),
    path: text('path').notNull(),
    createdAt: integer('created_at').notNull(),
    archivedAt: integer('archived_at'),
  },
  t => [index('projects_user_id_idx').on(t.userId)],
);

export const stories = sqliteTable(
  'stories',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, {onDelete: 'cascade'}),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, {onDelete: 'restrict'}),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    model: text('model').notNull(),
    status: text('status', {enum: STATUSES}).notNull().default('draft'),
    rank: text('rank').notNull(),
    progressPct: integer('progress_pct').notNull().default(0),
    progressLabel: text('progress_label').notNull().default(''),
    claimedByAgentId: text('claimed_by_agent_id').references((): AnySQLiteColumn => agents.id, {onDelete: 'set null'}),
    stopRequested: integer('stop_requested', {mode: 'boolean'}).notNull().default(false),
    playRequestedAt: integer('play_requested_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  t => [index('stories_user_status_idx').on(t.userId, t.status, t.rank)],
);

export const storyDependencies = sqliteTable(
  'story_dependencies',
  {
    storyId: text('story_id')
      .notNull()
      .references(() => stories.id, {onDelete: 'cascade'}),
    dependsOnStoryId: text('depends_on_story_id')
      .notNull()
      .references(() => stories.id, {onDelete: 'cascade'}),
  },
  t => [primaryKey({columns: [t.storyId, t.dependsOnStoryId]})],
);

export const storyUpdates = sqliteTable(
  'story_updates',
  {
    id: text('id').primaryKey(),
    storyId: text('story_id')
      .notNull()
      .references(() => stories.id, {onDelete: 'cascade'}),
    authorType: text('author_type', {enum: ['user', 'agent', 'system']}).notNull(),
    authorId: text('author_id').notNull(),
    kind: text('kind', {enum: ['progress', 'note', 'status_change', 'remark', 'error']}).notNull(),
    body: text('body').notNull(),
    progressPct: integer('progress_pct'),
    createdAt: integer('created_at').notNull(),
  },
  t => [index('story_updates_story_id_created_at_idx').on(t.storyId, t.createdAt)],
);

export const agents = sqliteTable(
  'agents',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, {onDelete: 'cascade'}),
    name: text('name').notNull(),
    autonomous: integer('autonomous', {mode: 'boolean'}).notNull().default(false),
    status: text('status', {enum: ['offline', 'idle', 'waiting', 'working']}).notNull().default('offline'),
    currentStoryId: text('current_story_id').references((): AnySQLiteColumn => stories.id, {onDelete: 'set null'}),
    /**
     * The remark-delivery watermark, not a presence signal: `controlBlock` advances it on
     * every tool call so each remark reaches the agent exactly once. Presence lives in
     * `lastActiveAt` — the two must not be conflated.
     */
    lastSeenAt: integer('last_seen_at'),
    /** When the agent last called a tool. What the offline sweep reads; never a watermark. */
    lastActiveAt: integer('last_active_at'),
    createdAt: integer('created_at').notNull(),
  },
  t => [index('agents_user_id_idx').on(t.userId)],
);

export const oauthClients = sqliteTable('oauth_clients', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id, {onDelete: 'cascade'}),
  clientId: text('client_id').notNull().unique(),
  clientSecretHash: text('client_secret_hash'),
  redirectUris: text('redirect_uris').notNull(),
  name: text('name').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const oauthCodes = sqliteTable('oauth_codes', {
  code: text('code').primaryKey(),
  clientId: text('client_id')
    .notNull()
    .references(() => oauthClients.id, {onDelete: 'cascade'}),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, {onDelete: 'cascade'}),
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id, {onDelete: 'cascade'}),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  scope: text('scope').notNull(),
  expiresAt: integer('expires_at').notNull(),
});

// accessTokenHash's `.unique()` already creates a unique index in SQLite, which
// satisfies the required oauth_tokens(access_token_hash) index — a second explicit
// index on the same column would be redundant.
export const oauthTokens = sqliteTable('oauth_tokens', {
  id: text('id').primaryKey(),
  clientId: text('client_id')
    .notNull()
    .references(() => oauthClients.id, {onDelete: 'cascade'}),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, {onDelete: 'cascade'}),
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id, {onDelete: 'cascade'}),
  accessTokenHash: text('access_token_hash').notNull().unique(),
  refreshTokenHash: text('refresh_token_hash').unique(),
  expiresAt: integer('expires_at').notNull(),
  revokedAt: integer('revoked_at'),
});

export const sessions = sqliteTable(
  'sessions',
  {
    sid: text('sid').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, {onDelete: 'cascade'}),
    data: text('data').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  t => [index('sessions_expires_at_idx').on(t.expiresAt)],
);
