#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequest,
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import pMemoize from "p-memoize";

// Type definitions for tool arguments
interface ListChannelsArgs {
  limit?: number;
  cursor?: string;
}

interface PostMessageArgs {
  channel_id: string;
  text: string;
}

interface ReplyToThreadArgs {
  channel_id: string;
  thread_ts: string;
  text: string;
}

interface AddReactionArgs {
  channel_id: string;
  timestamp: string;
  reaction: string;
}

interface GetChannelHistoryArgs {
  channel_id: string;
  limit?: number;
}

interface GetThreadRepliesArgs {
  channel_id: string;
  thread_ts: string;
}

interface GetUsersArgs {
  cursor?: string;
  limit?: number;
}

interface GetUserProfileArgs {
  user_id: string;
}

interface SearchMessagesArgs {
  query: string;
  count?: number;
  cursor?: string;
  highlight?: boolean;
  sort?: 'score' | 'timestamp';
  sort_dir?: 'asc' | 'desc';
}

// Tool definitions
const listChannelsTool: Tool = {
  name: "slack_list_channels",
  description: "List public channels in the workspace with pagination",
  inputSchema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description:
          "Maximum number of channels to return (default 100, max 200)",
        default: 100,
      },
      cursor: {
        type: "string",
        description: "Pagination cursor for next page of results",
      },
    },
  },
};

const postMessageTool: Tool = {
  name: "slack_post_message",
  description: "Post a new message to a Slack channel",
  inputSchema: {
    type: "object",
    properties: {
      channel_id: {
        type: "string",
        description: "The ID of the channel to post to",
      },
      text: {
        type: "string",
        description: "The message text to post",
      },
    },
    required: ["channel_id", "text"],
  },
};

const replyToThreadTool: Tool = {
  name: "slack_reply_to_thread",
  description: "Reply to a specific message thread in Slack",
  inputSchema: {
    type: "object",
    properties: {
      channel_id: {
        type: "string",
        description: "The ID of the channel containing the thread",
      },
      thread_ts: {
        type: "string",
        description: "The timestamp of the parent message in the format '1234567890.123456'. Timestamps in the format without the period can be converted by adding the period such that 6 numbers come after it.",
      },
      text: {
        type: "string",
        description: "The reply text",
      },
    },
    required: ["channel_id", "thread_ts", "text"],
  },
};

const addReactionTool: Tool = {
  name: "slack_add_reaction",
  description: "Add a reaction emoji to a message",
  inputSchema: {
    type: "object",
    properties: {
      channel_id: {
        type: "string",
        description: "The ID of the channel containing the message",
      },
      timestamp: {
        type: "string",
        description: "The timestamp of the message to react to",
      },
      reaction: {
        type: "string",
        description: "The name of the emoji reaction (without ::)",
      },
    },
    required: ["channel_id", "timestamp", "reaction"],
  },
};

const getChannelHistoryTool: Tool = {
  name: "slack_get_channel_history",
  description: "Get recent messages from a channel",
  inputSchema: {
    type: "object",
    properties: {
      channel_id: {
        type: "string",
        description: "The ID of the channel",
      },
      limit: {
        type: "number",
        description: "Number of messages to retrieve (default 10)",
        default: 10,
      },
    },
    required: ["channel_id"],
  },
};

const getThreadRepliesTool: Tool = {
  name: "slack_get_thread_replies",
  description: "Get a message and all replies in the message thread",
  inputSchema: {
    type: "object",
    properties: {
      channel_id: {
        type: "string",
        description: "The ID of the channel containing the thread",
      },
      thread_ts: {
        type: "string",
        description: "The timestamp of the parent message in the format '1234567890.123456'. Timestamps in the format without the period can be converted by adding the period such that 6 numbers come after it.",
      },
    },
    required: ["channel_id", "thread_ts"],
  },
};

const getUsersTool: Tool = {
  name: "slack_get_users",
  description:
    "Get a list of all users in the workspace with their basic profile information",
  inputSchema: {
    type: "object",
    properties: {
      cursor: {
        type: "string",
        description: "Pagination cursor for next page of results",
      },
      limit: {
        type: "number",
        description: "Maximum number of users to return (default 100, max 200)",
        default: 100,
      },
    },
  },
};

const getUserProfileTool: Tool = {
  name: "slack_get_user_profile",
  description: "Get detailed profile information for a specific user",
  inputSchema: {
    type: "object",
    properties: {
      user_id: {
        type: "string",
        description: "The ID of the user",
      },
    },
    required: ["user_id"],
  },
};

const searchMessagesTool: Tool = {
  name: "slack_search_messages",
  description: "Search for messages across the workspace",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query string (supports operators like from:@user, in:#channel)",
      },
      count: {
        type: "number",
        description: "Number of results to return (default 20, max 100)",
        default: 20,
        maximum: 100,
      },
      cursor: {
        type: "string",
        description: "Pagination cursor for next page of results",
      },
      highlight: {
        type: "boolean",
        description: "Enable search term highlighting",
        default: false,
      },
      sort: {
        type: "string",
        enum: ["score", "timestamp"],
        description: "Sort results by relevance score or timestamp",
      },
      sort_dir: {
        type: "string",
        enum: ["asc", "desc"],
        description: "Sort direction",
      },
    },
    required: ["query"],
  },
};

class SlackClient {
  private headers: { Authorization: string; "Content-Type": string };
  private isUserToken: boolean;
  private memoizedGetUser: (userId: string) => Promise<{displayName: string, username: string}>;

  constructor(token: string) {
    this.headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    this.isUserToken = token.startsWith('xoxp-');
    
    // Memoize user lookups to avoid repeated API calls
    this.memoizedGetUser = pMemoize(async (userId: string): Promise<{displayName: string, username: string}> => {
      try {
        const response = await fetch(`https://slack.com/api/users.info?user=${userId}`, {
          headers: this.headers,
        });
        const data = await response.json();
        
        if (data.ok && data.user) {
          return {
            displayName: data.user.profile?.display_name || data.user.real_name || data.user.name || userId,
            username: data.user.name || userId
          };
        }
        return { displayName: userId, username: userId };
      } catch (error) {
        console.error(`Failed to resolve user ${userId}:`, error);
        return { displayName: userId, username: userId };
      }
    });
  }

  private convertTimestampsToISO(obj: any): any {
    if (obj === null || obj === undefined) {
      return obj;
    }
    
    if (Array.isArray(obj)) {
      return obj.map(item => this.convertTimestampsToISO(item));
    }
    
    if (typeof obj === 'object') {
      const converted = { ...obj };
      for (const [key, value] of Object.entries(converted)) {
        if ((key === 'ts' || key === 'thread_ts' || key === 'timestamp' || key.endsWith('_ts')) && 
            typeof value === 'string' && /^\d+(\.\d+)?$/.test(value)) {
          const timestamp = parseFloat(value);
          converted[key] = new Date(timestamp * 1000).toISOString();
        } else if (typeof value === 'object') {
          converted[key] = this.convertTimestampsToISO(value);
        }
      }
      return converted;
    }
    
    return obj;
  }

  private async enrichWithUserInfo(obj: any): Promise<any> {
    if (!obj || typeof obj !== 'object') {
      return obj;
    }

    if (Array.isArray(obj)) {
      return Promise.all(obj.map(item => this.enrichWithUserInfo(item)));
    }

    const enriched = { ...obj };

    // Add user info fields if we have a user ID but missing readable names
    if (enriched.user && typeof enriched.user === 'string' && 
        enriched.user.match(/^U[A-Z0-9]+$/) && !enriched.user_display_name) {
      const userInfo = await this.memoizedGetUser(enriched.user);
      enriched.user_display_name = userInfo.displayName;
      enriched.user_username = userInfo.username;
    }

    // Recursively process nested objects
    for (const [key, value] of Object.entries(enriched)) {
      if (typeof value === 'object') {
        enriched[key] = await this.enrichWithUserInfo(value);
      }
    }

    return enriched;
  }

  async getChannels(limit: number = 100, cursor?: string): Promise<any> {
    const params = new URLSearchParams({
      types: "public_channel",
      exclude_archived: "true",
      limit: Math.min(limit, 200).toString(),
      team_id: process.env.SLACK_TEAM_ID!,
    });

    if (cursor) {
      params.append("cursor", cursor);
    }

    const response = await fetch(
      `https://slack.com/api/conversations.list?${params}`,
      { headers: this.headers },
    );

    const data = await response.json();
    return this.convertTimestampsToISO(data);
  }

  async postMessage(channel_id: string, text: string): Promise<any> {
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        channel: channel_id,
        text: text,
        as_user: this.isUserToken
      }),
    });

    const data = await response.json();
    return this.convertTimestampsToISO(data);
  }

  async postReply(
    channel_id: string,
    thread_ts: string,
    text: string,
  ): Promise<any> {
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        channel: channel_id,
        thread_ts: thread_ts,
        text: text,
        as_user: this.isUserToken
      }),
    });

    const data = await response.json();
    return this.convertTimestampsToISO(data);
  }

  async addReaction(
    channel_id: string,
    timestamp: string,
    reaction: string,
  ): Promise<any> {
    const response = await fetch("https://slack.com/api/reactions.add", {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        channel: channel_id,
        timestamp: timestamp,
        name: reaction,
      }),
    });

    const data = await response.json();
    return this.convertTimestampsToISO(data);
  }

  async getChannelHistory(
    channel_id: string,
    limit: number = 10,
  ): Promise<any> {
    const params = new URLSearchParams({
      channel: channel_id,
      limit: limit.toString(),
    });

    const response = await fetch(
      `https://slack.com/api/conversations.history?${params}`,
      { headers: this.headers },
    );

    const data = await response.json();
    return this.enrichWithUserInfo(this.convertTimestampsToISO(data));
  }

  async getThreadReplies(channel_id: string, thread_ts: string): Promise<any> {
    const params = new URLSearchParams({
      channel: channel_id,
      ts: thread_ts,
    });

    const response = await fetch(
      `https://slack.com/api/conversations.replies?${params}`,
      { headers: this.headers },
    );

    const data = await response.json();
    return this.enrichWithUserInfo(this.convertTimestampsToISO(data));
  }

  async getUsers(limit: number = 100, cursor?: string): Promise<any> {
    const params = new URLSearchParams({
      limit: Math.min(limit, 200).toString(),
      team_id: process.env.SLACK_TEAM_ID!,
    });

    if (cursor) {
      params.append("cursor", cursor);
    }

    const response = await fetch(`https://slack.com/api/users.list?${params}`, {
      headers: this.headers,
    });

    const data = await response.json();
    return this.convertTimestampsToISO(data);
  }

  async getUserProfile(user_id: string): Promise<any> {
    const params = new URLSearchParams({
      user: user_id,
      include_labels: "true",
    });

    const response = await fetch(
      `https://slack.com/api/users.profile.get?${params}`,
      { headers: this.headers },
    );

    const data = await response.json();
    return this.convertTimestampsToISO(data);
  }

  async searchMessages(
    query: string,
    count: number = 20,
    cursor?: string,
    highlight?: boolean,
    sort?: string,
    sort_dir?: string,
  ): Promise<any> {
    const params = new URLSearchParams({
      query: query,
      count: Math.min(count, 100).toString(),
      team_id: process.env.SLACK_TEAM_ID!,
    });

    if (cursor) params.append("cursor", cursor);
    if (highlight) params.append("highlight", "true");
    if (sort) params.append("sort", sort);
    if (sort_dir) params.append("sort_dir", sort_dir);

    const response = await fetch(
      `https://slack.com/api/search.messages?${params}`,
      { headers: this.headers },
    );

    const data = await response.json();
    return this.enrichWithUserInfo(this.convertTimestampsToISO(data));
  }
}

async function main() {
  const token = process.env.SLACK_TOKEN || process.env.SLACK_BOT_TOKEN;
  const teamId = process.env.SLACK_TEAM_ID;

  if (!token || !teamId) {
    console.error(
      "Please set SLACK_TOKEN (or SLACK_BOT_TOKEN) and SLACK_TEAM_ID environment variables",
    );
    process.exit(1);
  }

  console.error("Starting Slack MCP Server...");
  const server = new Server(
    {
      name: "Slack MCP Server",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  const slackClient = new SlackClient(token);

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request: CallToolRequest) => {
      console.error("Received CallToolRequest:", request);
      try {
        if (!request.params.arguments) {
          throw new Error("No arguments provided");
        }

        switch (request.params.name) {
          case "slack_list_channels": {
            const args = request.params
              .arguments as unknown as ListChannelsArgs;
            const response = await slackClient.getChannels(
              args.limit,
              args.cursor,
            );
            return {
              content: [{ type: "text", text: JSON.stringify(response) }],
            };
          }

          case "slack_post_message": {
            const args = request.params.arguments as unknown as PostMessageArgs;
            if (!args.channel_id || !args.text) {
              throw new Error(
                "Missing required arguments: channel_id and text",
              );
            }
            const response = await slackClient.postMessage(
              args.channel_id,
              args.text,
            );
            return {
              content: [{ type: "text", text: JSON.stringify(response) }],
            };
          }

          case "slack_reply_to_thread": {
            const args = request.params
              .arguments as unknown as ReplyToThreadArgs;
            if (!args.channel_id || !args.thread_ts || !args.text) {
              throw new Error(
                "Missing required arguments: channel_id, thread_ts, and text",
              );
            }
            const response = await slackClient.postReply(
              args.channel_id,
              args.thread_ts,
              args.text,
            );
            return {
              content: [{ type: "text", text: JSON.stringify(response) }],
            };
          }

          case "slack_add_reaction": {
            const args = request.params.arguments as unknown as AddReactionArgs;
            if (!args.channel_id || !args.timestamp || !args.reaction) {
              throw new Error(
                "Missing required arguments: channel_id, timestamp, and reaction",
              );
            }
            const response = await slackClient.addReaction(
              args.channel_id,
              args.timestamp,
              args.reaction,
            );
            return {
              content: [{ type: "text", text: JSON.stringify(response) }],
            };
          }

          case "slack_get_channel_history": {
            const args = request.params
              .arguments as unknown as GetChannelHistoryArgs;
            if (!args.channel_id) {
              throw new Error("Missing required argument: channel_id");
            }
            const response = await slackClient.getChannelHistory(
              args.channel_id,
              args.limit,
            );
            return {
              content: [{ type: "text", text: JSON.stringify(response) }],
            };
          }

          case "slack_get_thread_replies": {
            const args = request.params
              .arguments as unknown as GetThreadRepliesArgs;
            if (!args.channel_id || !args.thread_ts) {
              throw new Error(
                "Missing required arguments: channel_id and thread_ts",
              );
            }
            const response = await slackClient.getThreadReplies(
              args.channel_id,
              args.thread_ts,
            );
            return {
              content: [{ type: "text", text: JSON.stringify(response) }],
            };
          }

          case "slack_get_users": {
            const args = request.params.arguments as unknown as GetUsersArgs;
            const response = await slackClient.getUsers(
              args.limit,
              args.cursor,
            );
            return {
              content: [{ type: "text", text: JSON.stringify(response) }],
            };
          }

          case "slack_get_user_profile": {
            const args = request.params
              .arguments as unknown as GetUserProfileArgs;
            if (!args.user_id) {
              throw new Error("Missing required argument: user_id");
            }
            const response = await slackClient.getUserProfile(args.user_id);
            return {
              content: [{ type: "text", text: JSON.stringify(response) }],
            };
          }

          case "slack_search_messages": {
            const args = request.params.arguments as unknown as SearchMessagesArgs;
            if (!args.query) {
              throw new Error("Missing required argument: query");
            }
            const response = await slackClient.searchMessages(
              args.query,
              args.count,
              args.cursor,
              args.highlight,
              args.sort,
              args.sort_dir,
            );
            return {
              content: [{ type: "text", text: JSON.stringify(response) }],
            };
          }

          default:
            throw new Error(`Unknown tool: ${request.params.name}`);
        }
      } catch (error) {
        console.error("Error executing tool:", error);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
        };
      }
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    console.error("Received ListToolsRequest");
    return {
      tools: [
        listChannelsTool,
        postMessageTool,
        replyToThreadTool,
        addReactionTool,
        getChannelHistoryTool,
        getThreadRepliesTool,
        getUsersTool,
        getUserProfileTool,
        searchMessagesTool,
      ],
    };
  });

  const transport = new StdioServerTransport();
  console.error("Connecting server to transport...");
  await server.connect(transport);

  console.error("Slack MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
