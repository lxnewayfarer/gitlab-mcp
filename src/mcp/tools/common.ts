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

/**
 * Take the first or last `maxBytes` UTF-8 bytes of a string without splitting a
 * multibyte character at the cut. A cut mid-character leaves a single trailing
 * (for "start") or leading (for "end") U+FFFD replacement char; we drop exactly
 * that one boundary char so we never emit a stray replacement glyph — and never
 * touch replacement chars that were genuinely in the source.
 *
 * Returns the slice plus whether anything was cut, and operates on a Buffer the
 * caller can pass in to avoid re-encoding the same string twice.
 */
export function sliceByBytes(
  text: string,
  maxBytes: number,
  from: "start" | "end",
  buf: Buffer = Buffer.from(text, "utf-8"),
): { slice: string; truncated: boolean } {
  if (buf.length <= maxBytes) return { slice: text, truncated: false };
  const cut = from === "end" ? buf.subarray(buf.length - maxBytes) : buf.subarray(0, maxBytes);
  let slice = cut.toString("utf-8");
  // Strip at most one boundary replacement char (the partial multibyte char the
  // byte cut produced), not a run — a leading/trailing U+FFFD already in the
  // source must survive.
  if (from === "end" && slice.startsWith("�")) slice = slice.slice(1);
  else if (from === "start" && slice.endsWith("�")) slice = slice.slice(0, -1);
  return { slice, truncated: true };
}

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
