import { getConfig } from "../config/index.js";
import { GitLabApiError } from "../middleware/errors.js";

/**
 * GitLabService is the ONLY component permitted to call the GitLab REST API.
 * Every method acts on behalf of a single user via that user's access token,
 * so GitLab enforces the real permission model. No shared/service token exists.
 */

export interface MergeRequest {
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
  author?: { id: number; username: string };
  assignees?: Array<{ id: number; username: string }>;
  reviewers?: Array<{ id: number; username: string }>;
  created_at: string;
  updated_at: string;
  merge_status?: string;
  detailed_merge_status?: string;
}

export interface Note {
  id: number;
  body: string;
  author: { id: number; username: string };
  created_at: string;
}

export interface Pipeline {
  id: number;
  iid?: number;
  project_id: number;
  status: string;
  ref?: string;
  sha?: string;
  web_url: string;
  created_at: string;
  updated_at: string;
  started_at?: string | null;
  finished_at?: string | null;
}

export interface ListResult<T> {
  items: T[];
  pagination: {
    page: number;
    perPage: number;
    total: number | null;
    totalPages: number | null;
    nextPage: number | null;
  };
}

export interface ListMergeRequestsParams {
  state?: "opened" | "closed" | "merged" | "locked" | "all";
  authorUsername?: string;
  reviewerUsername?: string;
  page?: number;
  perPage?: number;
}

export interface ListPipelinesParams {
  ref?: string;
  status?: string;
  page?: number;
  perPage?: number;
}

type Query = Record<string, string | number | boolean | undefined | null>;

export class GitLabService {
  private readonly base: string;

  constructor(
    private readonly accessToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = getConfig().gitlabApiBase;
  }

  // --- low-level request helper ------------------------------------------

  private async request<T>(
    method: string,
    path: string,
    opts: { query?: Query; body?: unknown } = {},
  ): Promise<{ data: T; headers: Headers }> {
    const url = new URL(this.base + path);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined && v !== null && v !== "") {
          url.searchParams.set(k, String(v));
        }
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
      Accept: "application/json",
    };
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }

    const res = await this.fetchImpl(url.toString(), { method, headers, body });

    if (!res.ok) {
      const retryAfter = Number(res.headers.get("retry-after")) || undefined;
      let message = res.statusText;
      try {
        const errJson = (await res.json()) as { message?: unknown; error?: unknown };
        message =
          (typeof errJson.message === "string" && errJson.message) ||
          (typeof errJson.error === "string" && errJson.error) ||
          JSON.stringify(errJson);
      } catch {
        /* keep statusText */
      }
      throw new GitLabApiError(res.status, message, retryAfter);
    }

    const data = (res.status === 204 ? null : await res.json()) as T;
    return { data, headers: res.headers };
  }

  private encodeProjectId(projectId: string | number): string {
    // Supports numeric IDs and "group/project" paths.
    return encodeURIComponent(String(projectId));
  }

  private paginationFrom(headers: Headers, page: number, perPage: number) {
    const num = (h: string) => {
      const v = headers.get(h);
      return v != null && v !== "" ? Number(v) : null;
    };
    return {
      page,
      perPage,
      total: num("x-total"),
      totalPages: num("x-total-pages"),
      nextPage: num("x-next-page"),
    };
  }

  // --- authorization helper ----------------------------------------------

  /**
   * Confirms the user can access the project. Throws GitLabApiError(403/404)
   * otherwise. GitLab itself is the authority on access.
   */
  async assertProjectAccess(projectId: string | number): Promise<void> {
    await this.request("GET", `/projects/${this.encodeProjectId(projectId)}`);
  }

  // --- merge requests -----------------------------------------------------

  async createMergeRequest(
    projectId: string | number,
    input: {
      source_branch: string;
      target_branch: string;
      title: string;
      description?: string;
      labels?: string[];
      reviewer_ids?: number[];
      assignee_id?: number;
    },
  ): Promise<MergeRequest> {
    const { data } = await this.request<MergeRequest>(
      "POST",
      `/projects/${this.encodeProjectId(projectId)}/merge_requests`,
      {
        body: {
          source_branch: input.source_branch,
          target_branch: input.target_branch,
          title: input.title,
          description: input.description,
          labels: input.labels?.join(","),
          reviewer_ids: input.reviewer_ids,
          assignee_id: input.assignee_id,
        },
      },
    );
    return data;
  }

  async updateMergeRequest(
    projectId: string | number,
    iid: number,
    input: {
      title?: string;
      description?: string;
      labels?: string[];
      assignee_id?: number;
      reviewer_ids?: number[];
    },
  ): Promise<MergeRequest> {
    const body: Record<string, unknown> = {
      title: input.title,
      description: input.description,
      assignee_id: input.assignee_id,
      reviewer_ids: input.reviewer_ids,
    };
    if (input.labels !== undefined) body.labels = input.labels.join(",");
    const { data } = await this.request<MergeRequest>(
      "PUT",
      `/projects/${this.encodeProjectId(projectId)}/merge_requests/${iid}`,
      { body },
    );
    return data;
  }

  async getMergeRequest(
    projectId: string | number,
    iid: number,
  ): Promise<MergeRequest> {
    const { data } = await this.request<MergeRequest>(
      "GET",
      `/projects/${this.encodeProjectId(projectId)}/merge_requests/${iid}`,
    );
    return data;
  }

  async listMergeRequests(
    projectId: string | number,
    params: ListMergeRequestsParams,
  ): Promise<ListResult<MergeRequest>> {
    const page = params.page ?? 1;
    const perPage = params.perPage ?? 20;
    const { data, headers } = await this.request<MergeRequest[]>(
      "GET",
      `/projects/${this.encodeProjectId(projectId)}/merge_requests`,
      {
        query: {
          state: params.state,
          author_username: params.authorUsername,
          reviewer_username: params.reviewerUsername,
          page,
          per_page: perPage,
        },
      },
    );
    return { items: data, pagination: this.paginationFrom(headers, page, perPage) };
  }

  async addNote(
    projectId: string | number,
    iid: number,
    body: string,
  ): Promise<Note> {
    const { data } = await this.request<Note>(
      "POST",
      `/projects/${this.encodeProjectId(projectId)}/merge_requests/${iid}/notes`,
      { body: { body } },
    );
    return data;
  }

  // --- pipelines ----------------------------------------------------------

  async getPipeline(
    projectId: string | number,
    pipelineId: number,
  ): Promise<Pipeline> {
    const { data } = await this.request<Pipeline>(
      "GET",
      `/projects/${this.encodeProjectId(projectId)}/pipelines/${pipelineId}`,
    );
    return data;
  }

  async listPipelines(
    projectId: string | number,
    params: ListPipelinesParams,
  ): Promise<ListResult<Pipeline>> {
    const page = params.page ?? 1;
    const perPage = params.perPage ?? 20;
    const { data, headers } = await this.request<Pipeline[]>(
      "GET",
      `/projects/${this.encodeProjectId(projectId)}/pipelines`,
      {
        query: {
          ref: params.ref,
          status: params.status,
          page,
          per_page: perPage,
        },
      },
    );
    return { items: data, pagination: this.paginationFrom(headers, page, perPage) };
  }
}
