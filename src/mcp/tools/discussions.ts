import { z } from "zod";
import { defineTool } from "../types.js";
import { projectId, mergeRequestIid, discussionId } from "./common.js";

export const listMergeRequestDiscussions = defineTool({
  name: "list_merge_request_discussions",
  description:
    "List existing discussions on a merge request (for dedup before commenting).",
  schema: z.object({
    project_id: projectId,
    merge_request_iid: mergeRequestIid,
    page: z.number().int().positive().optional(),
    per_page: z.number().int().min(1).max(100).optional(),
  }),
  async handler(input, ctx) {
    await ctx.gitlab.assertProjectAccess(input.project_id);
    const result = await ctx.gitlab.listDiscussions(
      input.project_id,
      input.merge_request_iid,
      { page: input.page, perPage: input.per_page },
    );
    return {
      items: result.items.map((d) => ({
        id: d.id,
        notes: d.notes.map((n) => ({
          id: n.id,
          body: n.body,
          author: n.author.username,
          created_at: n.created_at,
          ...(n.position !== undefined ? { position: n.position } : {}),
        })),
      })),
      pagination: result.pagination,
    };
  },
});

export const replyToDiscussion = defineTool({
  name: "reply_to_discussion",
  description: "Reply to an existing merge request discussion.",
  schema: z.object({
    project_id: projectId,
    merge_request_iid: mergeRequestIid,
    discussion_id: discussionId,
    body: z.string().min(1),
  }),
  async handler(input, ctx) {
    await ctx.gitlab.assertProjectAccess(input.project_id);
    const note = await ctx.gitlab.replyToDiscussion(
      input.project_id,
      input.merge_request_iid,
      input.discussion_id,
      input.body,
    );
    return { note_id: note.id };
  },
});
