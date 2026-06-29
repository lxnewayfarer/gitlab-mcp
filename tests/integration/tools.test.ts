import { describe, it, expect, beforeAll, vi } from "vitest";
import { installTestConfig } from "../helpers/config.js";
import {
  createMergeRequest,
  updateMergeRequest,
  getMergeRequest,
  listMergeRequests,
} from "../../src/mcp/tools/mergeRequests.js";
import { addComment } from "../../src/mcp/tools/comments.js";
import { getPipelineStatus, listPipelines, getPipelineJobs, getJobLog } from "../../src/mcp/tools/pipelines.js";
import { getFileContent } from "../../src/mcp/tools/files.js";
import { assignReviewer, setLabels } from "../../src/mcp/tools/reviewersLabels.js";
import { getCurrentUser as getCurrentUserTool, findUser } from "../../src/mcp/tools/users.js";
import { getMergeRequestDiff, getMergeRequestVersions as getMrVersionsTool } from "../../src/mcp/tools/diffs.js";
import { listMergeRequestDiscussions, replyToDiscussion } from "../../src/mcp/tools/discussions.js";
import { approveMergeRequest, unapproveMergeRequest } from "../../src/mcp/tools/approvals.js";
import { buildMcpServer } from "../../src/mcp/server.js";
import type { AuthContext, ToolContext } from "../../src/mcp/types.js";
import { TOOLS } from "../../src/mcp/registry.js";

beforeAll(() => installTestConfig());

const auth: AuthContext = { userId: "u1", gitlabUserId: 99, username: "alice" };

const MR = {
  id: 100,
  iid: 5,
  project_id: 7,
  title: "T",
  description: "D",
  state: "opened",
  web_url: "https://gl/mr/5",
  source_branch: "feat",
  target_branch: "main",
  labels: ["bug"],
  assignees: [{ id: 1, username: "bob" }],
  reviewers: [{ id: 2, username: "carol" }],
  detailed_merge_status: "mergeable",
  created_at: "c",
  updated_at: "u",
};

const PIPELINE = {
  id: 55,
  project_id: 7,
  status: "success",
  ref: "main",
  sha: "abc",
  web_url: "https://gl/p/55",
  created_at: "c",
  updated_at: "u",
  started_at: "s",
  finished_at: "f",
};

const NOTE = { id: 11, body: "hi", author: { id: 2, username: "carol" }, created_at: "c" };

const JOB = {
  id: 200,
  name: "build",
  stage: "build",
  status: "failed",
  allow_failure: false,
  duration: 42,
  web_url: "https://gl/j/200",
  created_at: "c",
  started_at: "s",
  finished_at: "f",
};

/** A GitLabService stub that records calls and asserts access-check ordering. */
function makeStub() {
  const calls: string[] = [];
  const stub = {
    assertProjectAccess: vi.fn(async () => {
      calls.push("assertProjectAccess");
    }),
    createMergeRequest: vi.fn(async () => {
      calls.push("createMergeRequest");
      return MR;
    }),
    updateMergeRequest: vi.fn(async () => {
      calls.push("updateMergeRequest");
      return MR;
    }),
    getMergeRequest: vi.fn(async () => {
      calls.push("getMergeRequest");
      return MR;
    }),
    listMergeRequests: vi.fn(async () => {
      calls.push("listMergeRequests");
      return { items: [MR], pagination: { page: 1, perPage: 20, total: 1, totalPages: 1, nextPage: null } };
    }),
    addNote: vi.fn(async () => {
      calls.push("addNote");
      return NOTE;
    }),
    getPipeline: vi.fn(async () => {
      calls.push("getPipeline");
      return PIPELINE;
    }),
    listPipelines: vi.fn(async () => {
      calls.push("listPipelines");
      return { items: [PIPELINE], pagination: { page: 1, perPage: 20, total: 1, totalPages: 1, nextPage: null } };
    }),
    listPipelineJobs: vi.fn(async () => {
      calls.push("listPipelineJobs");
      return { items: [JOB], pagination: { page: 1, perPage: 20, total: 1, totalPages: 1, nextPage: null } };
    }),
    getJobTrace: vi.fn(async () => {
      calls.push("getJobTrace");
      // Includes an ANSI color sequence that the tool must strip.
      return "\u001b[31mboom\u001b[0m\nstack trace line\n";
    }),
    getFile: vi.fn(async () => {
      calls.push("getFile");
      return {
        file_path: "src/a.ts",
        size: 12,
        encoding: "text",
        content: "hello\nworld\n",
        blob_id: "deadbeef",
        ref: "main",
      };
    }),
    getCurrentUser: vi.fn(async () => {
      calls.push("getCurrentUser");
      return { id: 99, username: "alice", name: "Alice" };
    }),
    findUserByUsername: vi.fn(async (username: string) => {
      calls.push("findUserByUsername");
      return username === "ghost" ? null : { id: 3, username, name: "Bob" };
    }),
    getMergeRequestDiffs: vi.fn(async () => {
      calls.push("getMergeRequestDiffs");
      return [
        { old_path: "a", new_path: "a", diff: "@@", new_file: false, renamed_file: false, deleted_file: false },
      ];
    }),
    getMergeRequestVersions: vi.fn(async () => {
      calls.push("getMergeRequestVersions");
      return [{ base_commit_sha: "base", head_commit_sha: "head", start_commit_sha: "start" }];
    }),
    listDiscussions: vi.fn(async () => {
      calls.push("listDiscussions");
      return {
        items: [
          {
            id: "disc-1",
            notes: [
              { id: 11, body: "hi", author: { id: 2, username: "bob" }, created_at: "c", position: { new_line: 4 } },
            ],
          },
        ],
        pagination: { page: 1, perPage: 20, total: 1, totalPages: 1, nextPage: null },
      };
    }),
    replyToDiscussion: vi.fn(async () => {
      calls.push("replyToDiscussion");
      return { id: 77, body: "reply", author: { id: 2, username: "bob" }, created_at: "c" };
    }),
    approveMergeRequest: vi.fn(async () => {
      calls.push("approveMergeRequest");
      return { approved_by: [{ user: { id: 2, username: "bob" } }, { user: { id: 3, username: "carol" } }] };
    }),
    unapproveMergeRequest: vi.fn(async () => {
      calls.push("unapproveMergeRequest");
    }),
  };
  return { stub, calls };
}

function ctxWith(stub: unknown): ToolContext {
  return { auth, gitlab: stub as any };
}

describe("MCP tool handlers", () => {
  it("create_merge_request: checks access first, maps args, returns {url,id,iid,status}", async () => {
    const { stub, calls } = makeStub();
    const out = await createMergeRequest.handler(
      {
        project_id: 7,
        source_branch: "feat",
        target_branch: "main",
        title: "T",
        description: "D",
        labels: ["bug"],
        reviewers: [2],
        assignee_id: 1,
      },
      ctxWith(stub),
    );
    expect(calls[0]).toBe("assertProjectAccess");
    expect(stub.createMergeRequest).toHaveBeenCalledWith(7, {
      source_branch: "feat",
      target_branch: "main",
      title: "T",
      description: "D",
      labels: ["bug"],
      reviewer_ids: [2],
      assignee_id: 1,
    });
    expect(out).toEqual({ url: "https://gl/mr/5", id: 100, iid: 5, status: "opened" });
  });

  it("update_merge_request: returns presented MR with merge_status from detailed_merge_status", async () => {
    const { stub, calls } = makeStub();
    const out: any = await updateMergeRequest.handler(
      { project_id: 7, merge_request_iid: 5, title: "T2" },
      ctxWith(stub),
    );
    expect(calls).toEqual(["assertProjectAccess", "updateMergeRequest"]);
    expect(stub.updateMergeRequest).toHaveBeenCalledWith(7, 5, {
      title: "T2",
      description: undefined,
      labels: undefined,
      assignee_id: undefined,
    });
    expect(out.url).toBe("https://gl/mr/5");
    expect(out.merge_status).toBe("mergeable");
  });

  it("get_merge_request: returns presented MR", async () => {
    const { stub } = makeStub();
    const out: any = await getMergeRequest.handler(
      { project_id: 7, merge_request_iid: 5 },
      ctxWith(stub),
    );
    expect(stub.getMergeRequest).toHaveBeenCalledWith(7, 5);
    expect(out.id).toBe(100);
  });

  it("list_merge_requests: maps filters and returns items+pagination", async () => {
    const { stub } = makeStub();
    const out: any = await listMergeRequests.handler(
      { project_id: 7, state: "opened", author: "bob", reviewer: "carol", page: 1, per_page: 20 },
      ctxWith(stub),
    );
    expect(stub.listMergeRequests).toHaveBeenCalledWith(7, {
      state: "opened",
      authorUsername: "bob",
      reviewerUsername: "carol",
      page: 1,
      perPage: 20,
    });
    expect(out.items).toHaveLength(1);
    expect(out.pagination.total).toBe(1);
  });

  it("add_comment: calls addNote and returns the note", async () => {
    const { stub, calls } = makeStub();
    const out: any = await addComment.handler(
      { project_id: 7, merge_request_iid: 5, comment: "hi" },
      ctxWith(stub),
    );
    expect(calls).toEqual(["assertProjectAccess", "addNote"]);
    expect(stub.addNote).toHaveBeenCalledWith(7, 5, "hi");
    expect(out).toEqual({ id: 11, body: "hi", author: "carol", created_at: "c" });
  });

  it("get_pipeline_status: returns status, url, timestamps", async () => {
    const { stub } = makeStub();
    const out: any = await getPipelineStatus.handler(
      { project_id: 7, pipeline_id: 55 },
      ctxWith(stub),
    );
    expect(stub.getPipeline).toHaveBeenCalledWith(7, 55);
    expect(out).toMatchObject({
      id: 55,
      status: "success",
      url: "https://gl/p/55",
      started_at: "s",
      finished_at: "f",
    });
  });

  it("list_pipelines: maps branch->ref and returns items", async () => {
    const { stub } = makeStub();
    const out: any = await listPipelines.handler(
      { project_id: 7, branch: "main", status: "success" },
      ctxWith(stub),
    );
    expect(stub.listPipelines).toHaveBeenCalledWith(7, {
      ref: "main",
      status: "success",
      page: undefined,
      perPage: undefined,
    });
    expect(out.items[0].id).toBe(55);
  });

  it("get_pipeline_jobs: access first, maps pagination params, compact fields", async () => {
    const { stub, calls } = makeStub();
    const out: any = await getPipelineJobs.handler(
      { project_id: 7, pipeline_id: 55, page: 2, per_page: 50 },
      ctxWith(stub),
    );
    expect(calls).toEqual(["assertProjectAccess", "listPipelineJobs"]);
    expect(stub.listPipelineJobs).toHaveBeenCalledWith(7, 55, { page: 2, perPage: 50 });
    expect(out.items[0]).toEqual({
      id: 200,
      name: "build",
      stage: "build",
      status: "failed",
      allow_failure: false,
      duration: 42,
      url: "https://gl/j/200",
      created_at: "c",
      started_at: "s",
      finished_at: "f",
    });
    expect(out.pagination.page).toBe(1);
  });

  it("get_job_log: strips ANSI, returns tail by default with byte accounting", async () => {
    const { stub, calls } = makeStub();
    const out: any = await getJobLog.handler(
      { project_id: 7, job_id: 200 },
      ctxWith(stub),
    );
    expect(calls).toEqual(["assertProjectAccess", "getJobTrace"]);
    expect(stub.getJobTrace).toHaveBeenCalledWith(7, 200);
    // ANSI escapes removed.
    expect(out.log).toBe("boom\nstack trace line\n");
    expect(out.from).toBe("end");
    expect(out.truncated).toBe(false);
    expect(out.total_bytes).toBe(Buffer.byteLength("boom\nstack trace line\n", "utf-8"));
    expect(out.returned_bytes).toBe(out.total_bytes);
  });

  it("get_job_log: from='start' returns the head slice and marks truncation", async () => {
    const { stub } = makeStub();
    stub.getJobTrace = vi.fn(async () => "abcdefghij"); // 10 bytes, no ANSI
    const out: any = await getJobLog.handler(
      { project_id: 7, job_id: 200, from: "start", tail_bytes: 4 },
      ctxWith(stub),
    );
    expect(out.from).toBe("start");
    expect(out.log).toBe("abcd");
    expect(out.returned_bytes).toBe(4);
    expect(out.total_bytes).toBe(10);
    expect(out.truncated).toBe(true);
  });

  it("get_job_log: from='end' returns the tail slice", async () => {
    const { stub } = makeStub();
    stub.getJobTrace = vi.fn(async () => "abcdefghij");
    const out: any = await getJobLog.handler(
      { project_id: 7, job_id: 200, from: "end", tail_bytes: 4 },
      ctxWith(stub),
    );
    expect(out.log).toBe("ghij");
    expect(out.truncated).toBe(true);
  });

  it("get_job_log: strips GitLab section markers and carriage returns", async () => {
    const { stub } = makeStub();
    // GitLab collapsible-section framing: \x1b[0Ksection_start:TS:name\r\x1b[0K<header>
    stub.getJobTrace = vi.fn(
      async () =>
        "\u001b[0Ksection_start:1700000000:build\r\u001b[0KRunning build\nok\n" +
        "\u001b[0Ksection_end:1700000000:build\r\u001b[0K",
    );
    const out: any = await getJobLog.handler(
      { project_id: 7, job_id: 200, from: "start" },
      ctxWith(stub),
    );
    expect(out.log).not.toContain("section_start");
    expect(out.log).not.toContain("section_end");
    expect(out.log).not.toContain("\r");
    expect(out.log).toContain("Running build");
    expect(out.log).toContain("ok");
  });

  it("get_file_content: access first, returns content + metadata", async () => {
    const { stub, calls } = makeStub();
    const out: any = await getFileContent.handler(
      { project_id: 7, file_path: "src/a.ts", ref: "main" },
      ctxWith(stub),
    );
    expect(calls).toEqual(["assertProjectAccess", "getFile"]);
    expect(stub.getFile).toHaveBeenCalledWith(7, "src/a.ts", "main");
    expect(out).toEqual({
      file_path: "src/a.ts",
      ref: "main",
      size: 12,
      encoding: "text",
      blob_id: "deadbeef",
      content: "hello\nworld\n",
      truncated: false,
    });
  });

  it("get_file_content: truncates content over the 1 MiB cap", async () => {
    const { stub } = makeStub();
    const big = "x".repeat(1_048_576 + 100);
    stub.getFile = vi.fn(async () => ({
      file_path: "big.txt",
      size: big.length,
      encoding: "base64",
      content: big,
      blob_id: "b",
      ref: "main",
    }));
    const out: any = await getFileContent.handler(
      { project_id: 7, file_path: "big.txt", ref: "main" },
      ctxWith(stub),
    );
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(out.content, "utf-8")).toBe(1_048_576);
  });

  it("assign_reviewer: updates MR with reviewer_ids", async () => {
    const { stub } = makeStub();
    await assignReviewer.handler(
      { project_id: 7, merge_request_iid: 5, reviewer_ids: [2, 3] },
      ctxWith(stub),
    );
    expect(stub.updateMergeRequest).toHaveBeenCalledWith(7, 5, { reviewer_ids: [2, 3] });
  });

  it("set_labels: updates MR with labels", async () => {
    const { stub } = makeStub();
    await setLabels.handler(
      { project_id: 7, merge_request_iid: 5, labels: ["a", "b"] },
      ctxWith(stub),
    );
    expect(stub.updateMergeRequest).toHaveBeenCalledWith(7, 5, { labels: ["a", "b"] });
  });

  it("get_current_user: returns {id,username,name}, no access check", async () => {
    const { stub, calls } = makeStub();
    const out = await getCurrentUserTool.handler({}, ctxWith(stub));
    expect(calls).toEqual(["getCurrentUser"]);
    expect(out).toEqual({ id: 99, username: "alice", name: "Alice" });
  });

  it("find_user: returns the matched user, no access check", async () => {
    const { stub, calls } = makeStub();
    const out = await findUser.handler({ username: "bob" }, ctxWith(stub));
    expect(calls).toEqual(["findUserByUsername"]);
    expect(out).toEqual({ id: 3, username: "bob", name: "Bob" });
  });

  it("find_user: returns null when no user matches", async () => {
    const { stub, calls } = makeStub();
    const out = await findUser.handler({ username: "ghost" }, ctxWith(stub));
    expect(out).toBeNull();
    expect(calls).toEqual(["findUserByUsername"]);
  });

  it("get_merge_request_diff: access first, returns {files}", async () => {
    const { stub, calls } = makeStub();
    const out: any = await getMergeRequestDiff.handler(
      { project_id: 7, merge_request_iid: 5 },
      ctxWith(stub),
    );
    expect(calls).toEqual(["assertProjectAccess", "getMergeRequestDiffs"]);
    expect(stub.getMergeRequestDiffs).toHaveBeenCalledWith(7, 5);
    expect(out.files[0].new_path).toBe("a");
  });

  it("get_merge_request_versions: returns latest version SHAs", async () => {
    const { stub, calls } = makeStub();
    const out: any = await getMrVersionsTool.handler(
      { project_id: 7, merge_request_iid: 5 },
      ctxWith(stub),
    );
    expect(calls).toEqual(["assertProjectAccess", "getMergeRequestVersions"]);
    expect(out).toEqual({ base_commit_sha: "base", head_commit_sha: "head", start_commit_sha: "start" });
  });

  it("get_merge_request_versions: throws not_found when empty", async () => {
    const { stub, calls } = makeStub();
    stub.getMergeRequestVersions = vi.fn(async () => {
      calls.push("getMergeRequestVersions");
      return [];
    });
    await expect(
      getMrVersionsTool.handler({ project_id: 7, merge_request_iid: 5 }, ctxWith(stub)),
    ).rejects.toMatchObject({ status: 404 });
    expect(calls).toEqual(["assertProjectAccess", "getMergeRequestVersions"]);
  });

  it("list_merge_request_discussions: flattens author, passes position through", async () => {
    const { stub, calls } = makeStub();
    const out: any = await listMergeRequestDiscussions.handler(
      { project_id: 7, merge_request_iid: 5, page: 1, per_page: 20 },
      ctxWith(stub),
    );
    expect(calls).toEqual(["assertProjectAccess", "listDiscussions"]);
    expect(stub.listDiscussions).toHaveBeenCalledWith(7, 5, { page: 1, perPage: 20 });
    expect(out.items[0].id).toBe("disc-1");
    expect(out.items[0].notes[0].author).toBe("bob");
    expect(out.items[0].notes[0].position).toEqual({ new_line: 4 });
    expect(out.pagination.page).toBe(1);
  });

  it("list_merge_request_discussions: omits position key when note has none", async () => {
    const { stub } = makeStub();
    stub.listDiscussions = vi.fn(async () => ({
      items: [
        {
          id: "disc-2",
          notes: [
            { id: 22, body: "no pos", author: { id: 3, username: "dave" }, created_at: "c" },
          ],
        },
      ],
      pagination: { page: 1, perPage: 20, total: 1, totalPages: 1, nextPage: null },
    }));
    const out: any = await listMergeRequestDiscussions.handler(
      { project_id: 7, merge_request_iid: 5, page: 1, per_page: 20 },
      ctxWith(stub),
    );
    expect("position" in out.items[0].notes[0]).toBe(false);
  });

  it("reply_to_discussion: returns {note_id}", async () => {
    const { stub, calls } = makeStub();
    const out: any = await replyToDiscussion.handler(
      { project_id: 7, merge_request_iid: 5, discussion_id: "disc-1", body: "reply" },
      ctxWith(stub),
    );
    expect(calls).toEqual(["assertProjectAccess", "replyToDiscussion"]);
    expect(stub.replyToDiscussion).toHaveBeenCalledWith(7, 5, "disc-1", "reply");
    expect(out).toEqual({ note_id: 77 });
  });

  it("approve_merge_request: returns {approved, approved_by usernames}", async () => {
    const { stub, calls } = makeStub();
    const out: any = await approveMergeRequest.handler(
      { project_id: 7, merge_request_iid: 5 },
      ctxWith(stub),
    );
    expect(calls).toEqual(["assertProjectAccess", "approveMergeRequest"]);
    expect(stub.approveMergeRequest).toHaveBeenCalledWith(7, 5);
    expect(out).toEqual({ approved: true, approved_by: ["bob", "carol"] });
  });

  it("unapprove_merge_request: returns {unapproved:true}", async () => {
    const { stub, calls } = makeStub();
    const out: any = await unapproveMergeRequest.handler(
      { project_id: 7, merge_request_iid: 5 },
      ctxWith(stub),
    );
    expect(calls).toEqual(["assertProjectAccess", "unapproveMergeRequest"]);
    expect(stub.unapproveMergeRequest).toHaveBeenCalledWith(7, 5);
    expect(out).toEqual({ unapproved: true });
  });
});

/**
 * Verify the audit + error-mapping wrapper applied by buildMcpServer by capturing
 * the registered tool callback off a fake McpServer-like object.
 */
describe("buildMcpServer audit wrapper", () => {
  function captureHandlers(deps: Parameters<typeof buildMcpServer>[1]) {
    const handlers = new Map<string, (args: unknown) => Promise<any>>();
    const fakeServer = {
      registerTool: (name: string, _cfg: unknown, cb: (a: unknown) => Promise<any>) => {
        handlers.set(name, cb);
      },
    };
    // Patch: buildMcpServer creates its own McpServer, so instead we re-implement
    // capture by spying on McpServer.prototype.registerTool.
    return { handlers, fakeServer, deps };
  }

  it("records a success audit entry and returns text content", async () => {
    const audit = { record: vi.fn(async () => undefined) } as any;
    const tokens = { getAccessToken: vi.fn(async () => "tok") } as any;
    const { stub } = makeStub();
    const makeGitLab = vi.fn(() => stub as any);

    // Spy registerTool to capture callbacks.
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const captured = new Map<string, (a: unknown) => Promise<any>>();
    const spy = vi
      .spyOn(McpServer.prototype, "registerTool")
      .mockImplementation(function (this: any, name: string, _cfg: unknown, cb: any) {
        captured.set(name, cb);
        return {} as any;
      });

    buildMcpServer(auth, { audit, tokens, makeGitLab });
    const cb = captured.get("get_merge_request")!;
    const res = await cb({ project_id: 7, merge_request_iid: 5 });

    expect(res.content[0].type).toBe("text");
    expect(res.isError).toBeFalsy();
    expect(tokens.getAccessToken).toHaveBeenCalledWith("u1");
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls[0][0]).toMatchObject({
      userId: "u1",
      gitlabUsername: "alice",
      toolName: "get_merge_request",
      status: "success",
    });

    spy.mockRestore();
  });

  it("records an error audit entry and maps the error when a tool throws", async () => {
    const audit = { record: vi.fn(async () => undefined) } as any;
    const tokens = { getAccessToken: vi.fn(async () => "tok") } as any;
    const { GitLabApiError } = await import("../../src/middleware/errors.js");
    const stub = {
      assertProjectAccess: vi.fn(async () => {
        throw new GitLabApiError(403, "nope");
      }),
    };
    const makeGitLab = vi.fn(() => stub as any);

    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const captured = new Map<string, (a: unknown) => Promise<any>>();
    const spy = vi
      .spyOn(McpServer.prototype, "registerTool")
      .mockImplementation(function (this: any, name: string, _cfg: unknown, cb: any) {
        captured.set(name, cb);
        return {} as any;
      });

    buildMcpServer(auth, { audit, tokens, makeGitLab });
    const cb = captured.get("get_merge_request")!;
    const res = await cb({ project_id: 7, merge_request_iid: 5 });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/forbidden/);
    expect(audit.record.mock.calls[0][0]).toMatchObject({
      status: "error",
      toolName: "get_merge_request",
    });
    expect(audit.record.mock.calls[0][0].errorMessage).toMatch(/forbidden/);

    spy.mockRestore();
  });
});

describe("tool registry", () => {
  it("registers all 20 tools with unique names", () => {
    expect(TOOLS).toHaveLength(20);
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(20);
    for (const expected of [
      "get_current_user",
      "find_user",
      "get_merge_request_diff",
      "get_merge_request_versions",
      "list_merge_request_discussions",
      "reply_to_discussion",
      "approve_merge_request",
      "unapprove_merge_request",
      "get_pipeline_jobs",
      "get_job_log",
      "get_file_content",
    ]) {
      expect(names).toContain(expected);
    }
  });
});
