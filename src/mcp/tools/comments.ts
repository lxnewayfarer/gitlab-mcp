import { z } from "zod";
import { defineTool } from "../types.js";
import { projectId, mergeRequestIid } from "./common.js";

export const addComment = defineTool({
  name: "add_comment",
  description: "Add a comment (note) to a merge request.",
  schema: z.object({
    project_id: projectId,
    merge_request_iid: mergeRequestIid,
    comment: z.string().min(1),
  }),
  async handler(input, ctx) {
    await ctx.gitlab.assertProjectAccess(input.project_id);
    const note = await ctx.gitlab.addNote(
      input.project_id,
      input.merge_request_iid,
      input.comment,
    );
    return {
      id: note.id,
      body: note.body,
      author: note.author.username,
      created_at: note.created_at,
    };
  },
});
