import { z } from "zod";
import { defineTool } from "../types.js";
import { projectId, mergeRequestIid } from "./common.js";

export const approveMergeRequest = defineTool({
  name: "approve_merge_request",
  description:
    "Approve a merge request as the authenticated user. GitLab forbids self-approval and returns a permission error in that case.",
  schema: z.object({
    project_id: projectId,
    merge_request_iid: mergeRequestIid,
  }),
  async handler(input, ctx) {
    await ctx.gitlab.assertProjectAccess(input.project_id);
    const approval = await ctx.gitlab.approveMergeRequest(
      input.project_id,
      input.merge_request_iid,
    );
    return {
      approved: true,
      approved_by: (approval.approved_by ?? []).map((a) => a.user.username),
    };
  },
});

export const unapproveMergeRequest = defineTool({
  name: "unapprove_merge_request",
  description: "Revoke the authenticated user's approval of a merge request.",
  schema: z.object({
    project_id: projectId,
    merge_request_iid: mergeRequestIid,
  }),
  async handler(input, ctx) {
    await ctx.gitlab.assertProjectAccess(input.project_id);
    await ctx.gitlab.unapproveMergeRequest(
      input.project_id,
      input.merge_request_iid,
    );
    return { unapproved: true };
  },
});
