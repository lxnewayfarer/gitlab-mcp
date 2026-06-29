import { describe, it, expect, beforeAll, vi } from "vitest";
import { installTestConfig } from "../helpers/config.js";
import { GitLabService } from "../../src/services/gitlabService.js";
import { GitLabApiError } from "../../src/middleware/errors.js";

beforeAll(() => {
  installTestConfig();
});

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function textResponse(body: string, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { "content-type": "text/plain", ...(init.headers ?? {}) },
  });
}

describe("GitLabService", () => {
  it("createMergeRequest posts the correct URL and body", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ id: 10, iid: 2, web_url: "u", state: "opened" }),
    );
    const svc = new GitLabService("tok", fetchImpl as any);

    await svc.createMergeRequest("group/proj", {
      source_branch: "feat",
      target_branch: "main",
      title: "T",
      description: "D",
      labels: ["a", "b"],
      reviewer_ids: [1, 2],
      assignee_id: 5,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      "https://gitlab.example.com/api/v4/projects/group%2Fproj/merge_requests",
    );
    expect(opts.method).toBe("POST");
    expect(opts.headers.Authorization).toBe("Bearer tok");
    const sent = JSON.parse(opts.body);
    expect(sent).toMatchObject({
      source_branch: "feat",
      target_branch: "main",
      title: "T",
      description: "D",
      labels: "a,b", // joined with comma
      reviewer_ids: [1, 2],
      assignee_id: 5,
    });
  });

  it("updateMergeRequest joins labels and PUTs to the iid path", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 1, iid: 9 }));
    const svc = new GitLabService("tok", fetchImpl as any);
    await svc.updateMergeRequest(7, 9, { labels: ["x", "y"], title: "New" });

    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://gitlab.example.com/api/v4/projects/7/merge_requests/9");
    expect(opts.method).toBe("PUT");
    expect(JSON.parse(opts.body)).toMatchObject({ labels: "x,y", title: "New" });
  });

  it("listMergeRequests parses pagination headers", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([{ id: 1, iid: 1 }], {
        headers: { "x-total": "57", "x-total-pages": "3", "x-next-page": "2" },
      }),
    );
    const svc = new GitLabService("tok", fetchImpl as any);
    const res = await svc.listMergeRequests(7, { state: "opened", page: 1, perPage: 20 });

    expect(res.items).toHaveLength(1);
    expect(res.pagination).toEqual({
      page: 1,
      perPage: 20,
      total: 57,
      totalPages: 3,
      nextPage: 2,
    });
    // query params propagated
    const url = String(fetchImpl.mock.calls[0][0]);
    expect(url).toContain("state=opened");
    expect(url).toContain("per_page=20");
  });

  it("listMergeRequests yields null pagination when headers absent", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]));
    const svc = new GitLabService("tok", fetchImpl as any);
    const res = await svc.listMergeRequests(7, {});
    expect(res.pagination.total).toBeNull();
    expect(res.pagination.nextPage).toBeNull();
  });

  it("throws GitLabApiError with status 403 on forbidden", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ message: "403 Forbidden" }, { status: 403 }),
    );
    const svc = new GitLabService("tok", fetchImpl as any);
    const err = await svc.assertProjectAccess(7).catch((e) => e);
    expect(err).toBeInstanceOf(GitLabApiError);
    expect(err.status).toBe(403);
    expect(err.message).toBe("403 Forbidden");
  });

  it("captures retry-after on 429", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ message: "Too Many Requests" }, {
        status: 429,
        headers: { "retry-after": "12" },
      }),
    );
    const svc = new GitLabService("tok", fetchImpl as any);
    const err = await svc.getMergeRequest(7, 1).catch((e) => e);
    expect(err).toBeInstanceOf(GitLabApiError);
    expect(err.status).toBe(429);
    expect(err.retryAfter).toBe(12);
  });

  it("addNote posts the comment body", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ id: 1, body: "hi", author: { id: 1, username: "u" }, created_at: "t" }),
    );
    const svc = new GitLabService("tok", fetchImpl as any);
    await svc.addNote(7, 3, "hello there");
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      "https://gitlab.example.com/api/v4/projects/7/merge_requests/3/notes",
    );
    expect(JSON.parse(opts.body)).toEqual({ body: "hello there" });
  });

  it("listPipelines forwards ref and status filters", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([{ id: 1, status: "success" }]));
    const svc = new GitLabService("tok", fetchImpl as any);
    await svc.listPipelines(7, { ref: "main", status: "success" });
    const url = String(fetchImpl.mock.calls[0][0]);
    expect(url).toContain("ref=main");
    expect(url).toContain("status=success");
  });

  it("listPipelineJobs GETs the pipeline jobs path with pagination", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([{ id: 1, name: "build", stage: "build", status: "failed" }], {
        headers: { "x-total": "1", "x-total-pages": "1", "x-next-page": "" },
      }),
    );
    const svc = new GitLabService("tok", fetchImpl as any);
    const res = await svc.listPipelineJobs("g/p", 55, { page: 2, perPage: 50 });
    const url = String(fetchImpl.mock.calls[0][0]);
    expect(url).toBe(
      "https://gitlab.example.com/api/v4/projects/g%2Fp/pipelines/55/jobs?page=2&per_page=50",
    );
    expect(res.items[0].name).toBe("build");
    expect(res.pagination.page).toBe(2);
  });

  it("getJobTrace GETs the trace path and returns plain text", async () => {
    const fetchImpl = vi.fn(async () => textResponse("line1\nline2\n"));
    const svc = new GitLabService("tok", fetchImpl as any);
    const trace = await svc.getJobTrace(7, 123);
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://gitlab.example.com/api/v4/projects/7/jobs/123/trace");
    expect(opts.headers.Authorization).toBe("Bearer tok");
    expect(trace).toBe("line1\nline2\n");
  });

  it("getJobTrace throws GitLabApiError on 404", async () => {
    const fetchImpl = vi.fn(async () => textResponse("404 Not Found", { status: 404 }));
    const svc = new GitLabService("tok", fetchImpl as any);
    const err = await svc.getJobTrace(7, 123).catch((e) => e);
    expect(err).toBeInstanceOf(GitLabApiError);
    expect(err.status).toBe(404);
  });

  it("getFile URL-encodes the whole path, forwards ref, and decodes text as utf-8", async () => {
    const content = "hello\nworld\n";
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        file_path: "src/a.ts",
        size: content.length,
        encoding: "base64",
        content: Buffer.from(content, "utf-8").toString("base64"),
        blob_id: "deadbeef",
        ref: "main",
      }),
    );
    const svc = new GitLabService("tok", fetchImpl as any);
    const file = await svc.getFile("g/p", "src/a.ts", "main");
    const url = String(fetchImpl.mock.calls[0][0]);
    // Path is encoded whole: slashes become %2F.
    expect(url).toBe(
      "https://gitlab.example.com/api/v4/projects/g%2Fp/repository/files/src%2Fa.ts?ref=main",
    );
    expect(file.content).toBe(content);
    expect(file.blob_id).toBe("deadbeef");
    // A text file round-trips, so it's reported as text (not the raw base64).
    expect(file.encoding).toBe("text");
  });

  it("getFile keeps binary content as base64 instead of mangling it", async () => {
    // Bytes that are not valid UTF-8 (a lone 0xFF) — a PNG header sentinel here.
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0x01]);
    const b64 = bytes.toString("base64");
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        file_path: "logo.png",
        size: bytes.length,
        encoding: "base64",
        content: b64,
        blob_id: "cafef00d",
        ref: "main",
      }),
    );
    const svc = new GitLabService("tok", fetchImpl as any);
    const file = await svc.getFile("g/p", "logo.png", "main");
    expect(file.encoding).toBe("base64");
    // Content is the original base64 — losslessly recoverable, no U+FFFD.
    expect(Buffer.from(file.content, "base64").equals(bytes)).toBe(true);
  });

  it("getCurrentUser GETs /user", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ id: 7, username: "alice", name: "Alice" }),
    );
    const svc = new GitLabService("tok", fetchImpl as any);
    const u = await svc.getCurrentUser();
    expect(String(fetchImpl.mock.calls[0][0])).toBe("https://gitlab.example.com/api/v4/user");
    expect(u).toEqual({ id: 7, username: "alice", name: "Alice" });
  });

  it("findUserByUsername returns the first match", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([{ id: 3, username: "bob", name: "Bob" }]),
    );
    const svc = new GitLabService("tok", fetchImpl as any);
    const u = await svc.findUserByUsername("bob");
    expect(String(fetchImpl.mock.calls[0][0])).toContain("/users?username=bob");
    expect(u).toEqual({ id: 3, username: "bob", name: "Bob" });
  });

  it("findUserByUsername returns null when no user matches", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]));
    const svc = new GitLabService("tok", fetchImpl as any);
    expect(await svc.findUserByUsername("ghost")).toBeNull();
  });

  it("getMergeRequestDiffs stitches multiple pages", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([{ old_path: "a", new_path: "a", diff: "@@1", new_file: false, renamed_file: false, deleted_file: false }], {
          headers: { "x-next-page": "2" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse([{ old_path: "b", new_path: "b", diff: "@@2", new_file: true, renamed_file: false, deleted_file: false }], {
          headers: { "x-next-page": "" },
        }),
      );
    const svc = new GitLabService("tok", fetchImpl as any);
    const files = await svc.getMergeRequestDiffs(7, 5);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0][0])).toContain("/merge_requests/5/diffs");
    expect(String(fetchImpl.mock.calls[0][0])).toContain("per_page=100");
    expect(String(fetchImpl.mock.calls[1][0])).toContain("page=2");
    expect(files.map((f) => f.new_path)).toEqual(["a", "b"]);
  });

  it("getMergeRequestVersions GETs the versions path", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([
        { base_commit_sha: "base", head_commit_sha: "head", start_commit_sha: "start" },
      ]),
    );
    const svc = new GitLabService("tok", fetchImpl as any);
    const versions = await svc.getMergeRequestVersions("g/p", 9);
    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      "https://gitlab.example.com/api/v4/projects/g%2Fp/merge_requests/9/versions",
    );
    expect(versions[0]).toEqual({ base_commit_sha: "base", head_commit_sha: "head", start_commit_sha: "start" });
  });

  it("listDiscussions returns items + pagination", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        [{ id: "abc", notes: [{ id: 1, body: "hi", author: { id: 2, username: "bob" }, created_at: "c" }] }],
        { headers: { "x-total": "1", "x-total-pages": "1", "x-next-page": "" } },
      ),
    );
    const svc = new GitLabService("tok", fetchImpl as any);
    const res = await svc.listDiscussions(7, 5, { page: 1, perPage: 20 });
    expect(String(fetchImpl.mock.calls[0][0])).toContain("/merge_requests/5/discussions");
    expect(res.items[0].id).toBe("abc");
    expect(res.pagination.page).toBe(1);
  });

  it("replyToDiscussion POSTs to the discussion notes path", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ id: 42, body: "reply", author: { id: 2, username: "bob" }, created_at: "c" }),
    );
    const svc = new GitLabService("tok", fetchImpl as any);
    const note = await svc.replyToDiscussion("g/p", 9, "disc-1", "reply");
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe(
      "https://gitlab.example.com/api/v4/projects/g%2Fp/merge_requests/9/discussions/disc-1/notes",
    );
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ body: "reply" });
    expect(note.id).toBe(42);
  });

  it("approveMergeRequest POSTs the approve path", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ approved_by: [{ user: { id: 2, username: "bob" } }] }),
    );
    const svc = new GitLabService("tok", fetchImpl as any);
    const res = await svc.approveMergeRequest(7, 5);
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe(
      "https://gitlab.example.com/api/v4/projects/7/merge_requests/5/approve",
    );
    expect(opts.method).toBe("POST");
    expect(res.approved_by[0].user.username).toBe("bob");
  });

  it("unapproveMergeRequest POSTs unapprove and tolerates a 204", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const svc = new GitLabService("tok", fetchImpl as any);
    await expect(svc.unapproveMergeRequest(7, 5)).resolves.toBeUndefined();
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe(
      "https://gitlab.example.com/api/v4/projects/7/merge_requests/5/unapprove",
    );
    expect(opts.method).toBe("POST");
  });

  it("requestData throws 502 when response body is empty (204)", async () => {
    // getCurrentUser uses requestData; a 204 response produces data=null which
    // requestData should surface as a 502 GitLabApiError.
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const svc = new GitLabService("tok", fetchImpl as any);
    const err = await svc.getCurrentUser().catch((e) => e);
    expect(err).toBeInstanceOf(GitLabApiError);
    expect(err.status).toBe(502);
    expect(err.message).toMatch(/empty response/i);
  });

  it("replyToDiscussion URL-encodes reserved chars in discussionId", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ id: 99, body: "ok", author: { id: 2, username: "bob" }, created_at: "c" }),
    );
    const svc = new GitLabService("tok", fetchImpl as any);
    await svc.replyToDiscussion("g/p", 9, "disc/1", "reply");
    const [url] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain("/discussions/disc%2F1/notes");
  });
});
