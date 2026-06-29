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
import { getCurrentUser, findUser } from "./tools/users.js";
import { getMergeRequestDiff, getMergeRequestVersions } from "./tools/diffs.js";
import { listMergeRequestDiscussions, replyToDiscussion } from "./tools/discussions.js";
import { approveMergeRequest, unapproveMergeRequest } from "./tools/approvals.js";

/**
 * The complete, intentionally-curated tool surface (17 tools). Nothing outside
 * this list is exposed — no raw API proxy, no admin/destructive operations.
 * Read + diff + discussion-reply + approve operations on merge requests, plus
 * bounded user lookup.
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
  getCurrentUser,
  findUser,
  getMergeRequestDiff,
  getMergeRequestVersions,
  listMergeRequestDiscussions,
  replyToDiscussion,
  approveMergeRequest,
  unapproveMergeRequest,
];
