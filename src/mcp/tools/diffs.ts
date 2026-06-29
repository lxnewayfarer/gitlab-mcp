import { z } from "zod";
import { defineTool } from "../types.js";
import { projectId, mergeRequestIid } from "./common.js";
import { GitLabApiError } from "../../middleware/errors.js";

export const getMergeRequestDiff = defineTool({
  name: "get_merge_request_diff",
  description:
    "Get the full per-file diff of a merge request (auto-paginated) for change analysis.",
  schema: z.object({
    project_id: projectId,
    merge_request_iid: mergeRequestIid,
  }),
  async handler(input, ctx) {
    await ctx.gitlab.assertProjectAccess(input.project_id);
    const files = await ctx.gitlab.getMergeRequestDiffs(
      input.project_id,
      input.merge_request_iid,
    );
    return {
      files: files.map((f) => ({
        old_path: f.old_path,
        new_path: f.new_path,
        diff: f.diff,
        new_file: f.new_file,
        renamed_file: f.renamed_file,
        deleted_file: f.deleted_file,
      })),
    };
  },
});

export const getMergeRequestVersions = defineTool({
  name: "get_merge_request_versions",
  description:
    "Get the latest version's commit SHAs (base/head/start) of a merge request, used to position inline comments.",
  schema: z.object({
    project_id: projectId,
    merge_request_iid: mergeRequestIid,
  }),
  async handler(input, ctx) {
    await ctx.gitlab.assertProjectAccess(input.project_id);
    const versions = await ctx.gitlab.getMergeRequestVersions(
      input.project_id,
      input.merge_request_iid,
    );
    if (versions.length === 0) {
      throw new GitLabApiError(404, "This merge request has no diff versions yet.");
    }
    const latest = versions[0];
    return {
      base_commit_sha: latest.base_commit_sha,
      head_commit_sha: latest.head_commit_sha,
      start_commit_sha: latest.start_commit_sha,
    };
  },
});
