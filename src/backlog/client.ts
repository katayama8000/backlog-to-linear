import type {
  BacklogComment,
  BacklogIssue,
  BacklogNamed,
  BacklogProject,
  BacklogUser,
} from "./types.ts";

export type QueryValue = string | number | (string | number)[] | undefined;

export interface BacklogClientOptions {
  /** 例: xxx.backlog.jp / xxx.backlog.com */
  space: string;
  apiKey: string;
  /** テスト用の差し替え */
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

export class BacklogApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    super(`Backlog API ${status} ${path}: ${body.slice(0, 300)}`);
    this.name = "BacklogApiError";
  }
}

const RETRIABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export class BacklogClient {
  readonly spaceUrl: string;
  #apiKey: string;
  #fetch: typeof fetch;
  #sleep: (ms: number) => Promise<void>;
  #maxRetries: number;

  constructor(opts: BacklogClientOptions) {
    const host = opts.space.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    this.spaceUrl = `https://${host}`;
    this.#apiKey = opts.apiKey;
    this.#fetch = opts.fetchFn ?? globalThis.fetch;
    this.#sleep = opts.sleepFn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#maxRetries = opts.maxRetries ?? 5;
  }

  /** 429 / 5xx / ネットワークエラーを指数バックオフでリトライしつつ GET する */
  async get<T>(path: string, params: Record<string, QueryValue> = {}): Promise<T> {
    const url = new URL(`${this.spaceUrl}/api/v2${path}`);
    url.searchParams.set("apiKey", this.#apiKey);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const v of value) url.searchParams.append(`${key}[]`, String(v));
      } else {
        url.searchParams.set(key, String(value));
      }
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      if (attempt > 0) await this.#sleep(backoffMs(attempt, lastError));
      try {
        const res = await this.#fetch(url, { headers: { accept: "application/json" } });
        if (res.ok) return await res.json() as T;
        const body = await res.text();
        const error = new BacklogApiError(res.status, path, body);
        if (!RETRIABLE_STATUS.has(res.status)) throw error;
        lastError = withRetryAfter(error, res.headers.get("retry-after"));
      } catch (err) {
        if (err instanceof BacklogApiError && !RETRIABLE_STATUS.has(err.status)) throw err;
        lastError = err;
      }
    }
    throw lastError;
  }

  getMyself(): Promise<BacklogUser> {
    return this.get<BacklogUser>("/users/myself");
  }

  getProject(projectKey: string): Promise<BacklogProject> {
    return this.get<BacklogProject>(`/projects/${encodeURIComponent(projectKey)}`);
  }

  getStatuses(projectKey: string): Promise<BacklogNamed[]> {
    return this.get<BacklogNamed[]>(`/projects/${encodeURIComponent(projectKey)}/statuses`);
  }

  getIssueTypes(projectKey: string): Promise<BacklogNamed[]> {
    return this.get<BacklogNamed[]>(`/projects/${encodeURIComponent(projectKey)}/issueTypes`);
  }

  getCategories(projectKey: string): Promise<BacklogNamed[]> {
    return this.get<BacklogNamed[]>(`/projects/${encodeURIComponent(projectKey)}/categories`);
  }

  getVersions(projectKey: string): Promise<BacklogNamed[]> {
    return this.get<BacklogNamed[]>(`/projects/${encodeURIComponent(projectKey)}/versions`);
  }

  getProjectUsers(projectKey: string): Promise<BacklogUser[]> {
    return this.get<BacklogUser[]>(`/projects/${encodeURIComponent(projectKey)}/users`);
  }

  countIssues(query: IssueQuery): Promise<number> {
    return this.get<{ count: number }>("/issues/count", issueParams(query))
      .then((r) => r.count);
  }

  /** count=100 の上限に合わせて offset でページングする */
  async *iterIssues(query: IssueQuery): AsyncGenerator<BacklogIssue> {
    const pageSize = 100;
    for (let offset = 0;; offset += pageSize) {
      const page = await this.get<BacklogIssue[]>("/issues", {
        ...issueParams(query),
        sort: "created",
        order: "asc",
        count: pageSize,
        offset,
      });
      for (const issue of page) yield issue;
      if (page.length < pageSize) return;
    }
  }

  /** 内容が空のコメント（ステータス変更のみの履歴）は除外して全件返す */
  async getComments(issueKey: string): Promise<BacklogComment[]> {
    const pageSize = 100;
    const all: BacklogComment[] = [];
    let minId: number | undefined;
    for (;;) {
      const page = await this.get<BacklogComment[]>(
        `/issues/${encodeURIComponent(issueKey)}/comments`,
        { count: pageSize, order: "asc", minId },
      );
      all.push(...page);
      if (page.length < pageSize) break;
      minId = page[page.length - 1].id;
    }
    return all.filter((c) => (c.content ?? "").trim() !== "");
  }
}

export interface IssueQuery {
  projectId: number;
  statusId?: number[];
  updatedSince?: string;
}

function issueParams(query: IssueQuery): Record<string, QueryValue> {
  return {
    projectId: [query.projectId],
    statusId: query.statusId?.length ? query.statusId : undefined,
    updatedSince: query.updatedSince,
  };
}

function withRetryAfter(error: BacklogApiError, header: string | null): unknown {
  const seconds = header ? Number(header) : NaN;
  if (Number.isFinite(seconds)) {
    return Object.assign(error, { retryAfterMs: Math.max(0, seconds * 1000) });
  }
  return error;
}

function backoffMs(attempt: number, lastError: unknown): number {
  const hinted = (lastError as { retryAfterMs?: number } | undefined)?.retryAfterMs;
  if (typeof hinted === "number") return hinted;
  const base = 500 * 2 ** (attempt - 1);
  return Math.min(base, 16_000) + Math.random() * 250;
}
