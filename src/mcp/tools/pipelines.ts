import { z } from "zod";
import { defineTool } from "../types.js";
import { projectId } from "./common.js";

export const getPipelineStatus = defineTool({
  name: "get_pipeline_status",
  description: "Get the status, URL and timestamps of a pipeline.",
  schema: z.object({
    project_id: projectId,
    pipeline_id: z.number().int().positive(),
  }),
  async handler(input, ctx) {
    await ctx.gitlab.assertProjectAccess(input.project_id);
    const p = await ctx.gitlab.getPipeline(input.project_id, input.pipeline_id);
    return {
      id: p.id,
      status: p.status,
      ref: p.ref ?? null,
      url: p.web_url,
      created_at: p.created_at,
      updated_at: p.updated_at,
      started_at: p.started_at ?? null,
      finished_at: p.finished_at ?? null,
    };
  },
});

export const listPipelines = defineTool({
  name: "list_pipelines",
  description: "List pipelines in a project, optionally filtered by branch and status.",
  schema: z.object({
    project_id: projectId,
    branch: z.string().optional().describe("Filter by git ref / branch"),
    status: z
      .enum([
        "created",
        "waiting_for_resource",
        "preparing",
        "pending",
        "running",
        "success",
        "failed",
        "canceled",
        "skipped",
        "manual",
        "scheduled",
      ])
      .optional(),
    page: z.number().int().positive().optional(),
    per_page: z.number().int().min(1).max(100).optional(),
  }),
  async handler(input, ctx) {
    await ctx.gitlab.assertProjectAccess(input.project_id);
    const result = await ctx.gitlab.listPipelines(input.project_id, {
      ref: input.branch,
      status: input.status,
      page: input.page,
      perPage: input.per_page,
    });
    return {
      items: result.items.map((p) => ({
        id: p.id,
        status: p.status,
        ref: p.ref ?? null,
        sha: p.sha ?? null,
        url: p.web_url,
        created_at: p.created_at,
        updated_at: p.updated_at,
      })),
      pagination: result.pagination,
    };
  },
});
