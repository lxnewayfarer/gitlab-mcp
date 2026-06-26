import { z } from "zod";
import { defineTool } from "../types.js";
import { projectId, mergeRequestIid, presentMergeRequest } from "./common.js";

export const assignReviewer = defineTool({
  name: "assign_reviewer",
  description: "Set the reviewers of a merge request (replaces existing reviewers).",
  schema: z.object({
    project_id: projectId,
    merge_request_iid: mergeRequestIid,
    reviewer_ids: z.array(z.number().int().positive()).min(1),
  }),
  async handler(input, ctx) {
    await ctx.gitlab.assertProjectAccess(input.project_id);
    const mr = await ctx.gitlab.updateMergeRequest(
      input.project_id,
      input.merge_request_iid,
      { reviewer_ids: input.reviewer_ids },
    );
    return presentMergeRequest(mr);
  },
});

export const setLabels = defineTool({
  name: "set_labels",
  description: "Set the labels of a merge request (replaces existing labels).",
  schema: z.object({
    project_id: projectId,
    merge_request_iid: mergeRequestIid,
    labels: z.array(z.string()),
  }),
  async handler(input, ctx) {
    await ctx.gitlab.assertProjectAccess(input.project_id);
    const mr = await ctx.gitlab.updateMergeRequest(
      input.project_id,
      input.merge_request_iid,
      { labels: input.labels },
    );
    return presentMergeRequest(mr);
  },
});
