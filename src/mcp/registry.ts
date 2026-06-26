import type { ToolDefinition } from "./types.js";
import {
  createMergeRequest,
  updateMergeRequest,
  getMergeRequest,
  listMergeRequests,
} from "./tools/mergeRequests.js";
import { addComment } from "./tools/comments.js";
import { getPipelineStatus, listPipelines } from "./tools/pipelines.js";
import { assignReviewer, setLabels } from "./tools/reviewersLabels.js";

/**
 * The complete, intentionally-minimal tool surface. Nothing outside this list
 * is exposed — no raw API proxy, no admin/destructive operations.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const TOOLS: ToolDefinition<any>[] = [
  createMergeRequest,
  updateMergeRequest,
  getMergeRequest,
  listMergeRequests,
  addComment,
  getPipelineStatus,
  listPipelines,
  assignReviewer,
  setLabels,
];
