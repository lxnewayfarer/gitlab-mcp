import { z } from "zod";
import { defineTool } from "../types.js";
import { projectId, mergeRequestIid, presentMergeRequest, labels as labelsSchema } from "./common.js";

export const createMergeRequest = defineTool({
  name: "create_merge_request",
  description:
    "Create a merge request in a GitLab project on behalf of the authenticated user.",
  schema: z.object({
    project_id: projectId,
    source_branch: z.string().min(1),
    target_branch: z.string().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
    labels: labelsSchema.optional(),
    reviewers: z
      .array(z.number().int().positive())
      .optional()
      .describe("Reviewer user IDs"),
    assignee_id: z.number().int().positive().optional(),
  }),
  async handler(input, ctx) {
    await ctx.gitlab.assertProjectAccess(input.project_id);
    const mr = await ctx.gitlab.createMergeRequest(input.project_id, {
      source_branch: input.source_branch,
      target_branch: input.target_branch,
      title: input.title,
      description: input.description,
      labels: input.labels,
      reviewer_ids: input.reviewers,
      assignee_id: input.assignee_id,
    });
    return { url: mr.web_url, id: mr.id, iid: mr.iid, status: mr.state };
  },
});

export const updateMergeRequest = defineTool({
  name: "update_merge_request",
  description: "Update fields of an existing merge request.",
  schema: z.object({
    project_id: projectId,
    merge_request_iid: mergeRequestIid,
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    labels: labelsSchema.optional(),
    assignee_id: z.number().int().positive().optional(),
  }),
  async handler(input, ctx) {
    await ctx.gitlab.assertProjectAccess(input.project_id);
    const mr = await ctx.gitlab.updateMergeRequest(
      input.project_id,
      input.merge_request_iid,
      {
        title: input.title,
        description: input.description,
        labels: input.labels,
        assignee_id: input.assignee_id,
      },
    );
    return presentMergeRequest(mr);
  },
});

export const getMergeRequest = defineTool({
  name: "get_merge_request",
  description: "Get details of a single merge request.",
  schema: z.object({
    project_id: projectId,
    merge_request_iid: mergeRequestIid,
  }),
  async handler(input, ctx) {
    await ctx.gitlab.assertProjectAccess(input.project_id);
    const mr = await ctx.gitlab.getMergeRequest(
      input.project_id,
      input.merge_request_iid,
    );
    return presentMergeRequest(mr);
  },
});

export const listMergeRequests = defineTool({
  name: "list_merge_requests",
  description: "List merge requests in a project, with optional filters and pagination.",
  schema: z.object({
    project_id: projectId,
    state: z.enum(["opened", "closed", "merged", "locked", "all"]).optional(),
    author: z.string().optional().describe("Filter by author username"),
    reviewer: z.string().optional().describe("Filter by reviewer username"),
    page: z.number().int().positive().optional(),
    per_page: z.number().int().min(1).max(100).optional(),
  }),
  async handler(input, ctx) {
    await ctx.gitlab.assertProjectAccess(input.project_id);
    const result = await ctx.gitlab.listMergeRequests(input.project_id, {
      state: input.state,
      authorUsername: input.author,
      reviewerUsername: input.reviewer,
      page: input.page,
      perPage: input.per_page,
    });
    return {
      items: result.items.map(presentMergeRequest),
      pagination: result.pagination,
    };
  },
});
