import { describe, it, expect, beforeAll, vi } from "vitest";
import { installTestConfig } from "../helpers/config.js";
import {
  createMergeRequest,
  updateMergeRequest,
  getMergeRequest,
  listMergeRequests,
} from "../../src/mcp/tools/mergeRequests.js";
import { addComment } from "../../src/mcp/tools/comments.js";
import { getPipelineStatus, listPipelines } from "../../src/mcp/tools/pipelines.js";
import { assignReviewer, setLabels } from "../../src/mcp/tools/reviewersLabels.js";
import { buildMcpServer } from "../../src/mcp/server.js";
import type { AuthContext, ToolContext } from "../../src/mcp/types.js";

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
