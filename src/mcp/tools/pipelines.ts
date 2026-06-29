import { z } from "zod";
import { defineTool } from "../types.js";
import { projectId, sliceByBytes } from "./common.js";

const JOB_LOG_DEFAULT_BYTES = 64 * 1024; // 64 KiB
const JOB_LOG_MAX_BYTES = 1024 * 1024; // 1 MiB

// CI runners emit SGR color codes plus cursor/clear-line sequences (the general
// CSI form), and GitLab wraps collapsible sections in markers like
// "\x1b[0Ksection_start:1700000000:build\r\x1b[0K<header>". Strip the ANSI
// sequences, the literal section_start/section_end tokens, and stray carriage
// returns so the returned log is clean text.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const SECTION_RE = /^(?:section_start|section_end):\d+:[^\r\n]*/gm;
function cleanTrace(s: string): string {
  return s
    .replace(ANSI_RE, "")
    .replace(SECTION_RE, "")
    .replace(/\r/g, "");
}

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

export const getPipelineJobs = defineTool({
  name: "get_pipeline_jobs",
  description:
    "List the jobs of a pipeline (name, stage, status, timing). Use a job's id with get_job_log.",
  schema: z.object({
    project_id: projectId,
    pipeline_id: z.number().int().positive(),
    page: z.number().int().positive().optional(),
    per_page: z.number().int().min(1).max(100).optional(),
  }),
  async handler(input, ctx) {
    await ctx.gitlab.assertProjectAccess(input.project_id);
    const result = await ctx.gitlab.listPipelineJobs(input.project_id, input.pipeline_id, {
      page: input.page,
      perPage: input.per_page,
    });
    return {
      items: result.items.map((j) => ({
        id: j.id,
        name: j.name,
        stage: j.stage,
        status: j.status,
        allow_failure: j.allow_failure,
        duration: j.duration ?? null,
        url: j.web_url,
        created_at: j.created_at,
        started_at: j.started_at ?? null,
        finished_at: j.finished_at ?? null,
      })),
      pagination: result.pagination,
    };
  },
});

export const getJobLog = defineTool({
  name: "get_job_log",
  description:
    "Fetch a CI job's log (trace), ANSI-stripped. Returns a bounded slice (default the last 64 KiB; set from='start' for the head). total_bytes/truncated indicate whether more remains.",
  schema: z.object({
    project_id: projectId,
    job_id: z.number().int().positive(),
    tail_bytes: z
      .number()
      .int()
      .min(1)
      .max(JOB_LOG_MAX_BYTES)
      .optional()
      .describe(`Max bytes to return (default ${JOB_LOG_DEFAULT_BYTES}, max ${JOB_LOG_MAX_BYTES})`),
    from: z
      .enum(["end", "start"])
      .optional()
      .describe("Which end of the log to slice: 'end' (default, the tail) or 'start' (the head)"),
  }),
  async handler(input, ctx) {
    await ctx.gitlab.assertProjectAccess(input.project_id);
    const raw = await ctx.gitlab.getJobTrace(input.project_id, input.job_id);
    const log = cleanTrace(raw);
    const from = input.from ?? "end";
    const maxBytes = input.tail_bytes ?? JOB_LOG_DEFAULT_BYTES;
    // Encode once; reuse the buffer for both the byte count and the slice.
    const buf = Buffer.from(log, "utf-8");
    const { slice, truncated } = sliceByBytes(log, maxBytes, from, buf);
    return {
      log: slice,
      from,
      truncated,
      returned_bytes: Buffer.byteLength(slice, "utf-8"),
      total_bytes: buf.length,
    };
  },
});
