import { z } from "zod";

/** project_id accepts a numeric ID or a "group/project" path. */
export const projectId = z
  .union([z.number().int().positive(), z.string().min(1)])
  .describe("Numeric project ID or URL-encoded 'group/project' path");

export const mergeRequestIid = z
  .number()
  .int()
  .positive()
  .describe("The project-scoped merge request IID (not the global id)");

/**
 * A single GitLab label. Labels are sent to GitLab as a comma-joined string, so
 * a value containing a comma would be silently split into multiple labels.
 * Reject commas (and blank values) at the input boundary.
 */
export const label = z
  .string()
  .trim()
  .min(1, "label must not be empty")
  .refine((s) => !s.includes(","), "label must not contain a comma");

export const labels = z.array(label);

/** A GitLab discussion id (opaque string, e.g. a 40-char hash). */
export const discussionId = z
  .string()
  .min(1)
  .describe("The discussion id returned by list_merge_request_discussions");

/** Compact MR shape returned to the agent. */
export function presentMergeRequest(mr: {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description: string | null;
  state: string;
  web_url: string;
  source_branch: string;
  target_branch: string;
  labels: string[];
  assignees?: Array<{ id: number; username: string }>;
  reviewers?: Array<{ id: number; username: string }>;
  detailed_merge_status?: string;
  merge_status?: string;
  created_at: string;
  updated_at: string;
}) {
  return {
    id: mr.id,
    iid: mr.iid,
    project_id: mr.project_id,
    title: mr.title,
    description: mr.description,
    state: mr.state,
    url: mr.web_url,
    source_branch: mr.source_branch,
    target_branch: mr.target_branch,
    labels: mr.labels,
    assignees: mr.assignees?.map((a) => ({ id: a.id, username: a.username })) ?? [],
    reviewers: mr.reviewers?.map((r) => ({ id: r.id, username: r.username })) ?? [],
    merge_status: mr.detailed_merge_status ?? mr.merge_status ?? null,
    created_at: mr.created_at,
    updated_at: mr.updated_at,
  };
}
