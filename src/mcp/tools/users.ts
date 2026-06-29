import { z } from "zod";
import { defineTool } from "../types.js";

export const getCurrentUser = defineTool({
  name: "get_current_user",
  description:
    "Return the authenticated GitLab user (for self-review detection).",
  schema: z.object({}),
  async handler(_input, ctx) {
    const u = await ctx.gitlab.getCurrentUser();
    return { id: u.id, username: u.username, name: u.name };
  },
});

export const findUser = defineTool({
  name: "find_user",
  description:
    "Resolve a GitLab username to its numeric user ID. Returns null if no user matches.",
  schema: z.object({
    username: z.string().min(1),
  }),
  async handler(input, ctx) {
    const u = await ctx.gitlab.findUserByUsername(input.username);
    return u ? { id: u.id, username: u.username, name: u.name } : null;
  },
});
