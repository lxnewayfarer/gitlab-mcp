import { z } from "zod";
import type { GitLabService } from "../services/gitlabService.js";

/** Authenticated context attached by the bearer-auth middleware. */
export interface AuthContext {
  userId: string;
  gitlabUserId: number;
  username: string;
}

/** Everything a tool handler needs to execute. */
export interface ToolContext {
  auth: AuthContext;
  gitlab: GitLabService;
}

/** A registered MCP tool. */
export interface ToolDefinition<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  schema: S;
  handler: (input: z.infer<S>, ctx: ToolContext) => Promise<unknown>;
}

export function defineTool<S extends z.ZodTypeAny>(
  def: ToolDefinition<S>,
): ToolDefinition<S> {
  return def;
}
