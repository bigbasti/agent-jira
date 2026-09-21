import {McpServer, ResourceTemplate} from '@modelcontextprotocol/sdk/server/mcp.js';
import {getBoard} from '../services/board.js';
import {listProjects} from '../services/projects.js';
import {getStory, listUpdates} from '../services/stories.js';
import {INSTRUCTIONS} from './instructions.js';
import {registerTools, type McpContext} from './tools.js';

export type {McpContext} from './tools.js';

const SERVER_NAME = 'agent-jira';
const SERVER_VERSION = '0.1.0';

/** The board, as a resource — the same snapshot `get_board` returns. */
function registerResources(server: McpServer, ctx: McpContext): void {
  server.registerResource(
    'board',
    'board://current',
    {
      title: 'The board',
      description: 'The current kanban board: columns, stories, projects and agents.',
      mimeType: 'application/json',
    },
    async uri => ({
      contents: [{uri: uri.href, mimeType: 'application/json', text: JSON.stringify(getBoard(ctx.db, ctx.userId))}],
    }),
  );

  server.registerResource(
    'story',
    // `list: undefined` on purpose: stories are enumerated through `board://current`
    // (or `get_board`), and duplicating that as a resource listing would give an agent
    // two subtly different views of the same column order.
    new ResourceTemplate('story://{id}', {list: undefined}),
    {
      title: 'A story',
      description: 'One story with its project and its timeline of updates.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const raw: string | string[] | undefined = variables.id;
      const storyId = (Array.isArray(raw) ? raw[0] : raw) ?? '';
      const story = getStory(ctx.db, ctx.userId, storyId);
      const project = listProjects(ctx.db, ctx.userId).find(candidate => candidate.id === story.projectId) ?? null;
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({story, project, updates: listUpdates(ctx.db, ctx.userId, storyId)}),
          },
        ],
      };
    },
  );
}

/**
 * Builds a fresh MCP server bound to one authenticated agent.
 *
 * One server per request: the transport runs stateless, and `userId`/`agentId` come from
 * the bearer token, so nothing an agent sends can widen what its tools can reach. The
 * instructions string travels with the `initialize` response and is the agent's entire
 * briefing.
 */
export function buildMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer({name: SERVER_NAME, version: SERVER_VERSION}, {instructions: INSTRUCTIONS});
  registerTools(server, ctx);
  registerResources(server, ctx);
  return server;
}
