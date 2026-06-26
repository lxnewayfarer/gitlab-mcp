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
