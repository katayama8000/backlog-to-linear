/** Linear GraphQL API の最小クライアント（この CLI が使う操作のみ） */

export interface LinearClientOptions {
  apiKey: string;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  maxRetries?: number;
  endpoint?: string;
}

export class LinearApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "LinearApiError";
  }
}

export interface LinearIssueRef {
  id: string;
  identifier: string;
  description: string | null;
  parentId: string | null;
}

const RETRIABLE_STATUS = new Set([429, 500, 502, 503, 504]);

const ISSUES_QUERY = `
query Issues($key: String!, $after: String) {
  issues(first: 100, after: $after, filter: { team: { key: { eq: $key } } }) {
    nodes { id identifier description parent { id } }
    pageInfo { hasNextPage endCursor }
  }
}`;

const SET_PARENT_MUTATION = `
mutation SetParent($id: String!, $parentId: String!) {
  issueUpdate(id: $id, input: { parentId: $parentId }) { success }
}`;

const VIEWER_QUERY = `query Viewer { viewer { id name email } }`;

export class LinearClient {
  #apiKey: string;
  #fetch: typeof fetch;
  #sleep: (ms: number) => Promise<void>;
  #maxRetries: number;
  #endpoint: string;

  constructor(opts: LinearClientOptions) {
    this.#apiKey = opts.apiKey;
    this.#fetch = opts.fetchFn ?? globalThis.fetch;
    this.#sleep = opts.sleepFn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#maxRetries = opts.maxRetries ?? 5;
    this.#endpoint = opts.endpoint ?? "https://api.linear.app/graphql";
  }

  async request<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      if (attempt > 0) await this.#sleep(backoffMs(attempt, lastError));
      try {
        const res = await this.#fetch(this.#endpoint, {
          method: "POST",
          headers: {
            // Personal API key は Bearer を付けずそのまま渡す
            authorization: this.#apiKey,
            "content-type": "application/json",
          },
          body: JSON.stringify({ query, variables }),
        });

        if (!res.ok) {
          const body = await res.text();
          const error = new LinearApiError(
            `Linear API ${res.status}: ${body.slice(0, 300)}`,
            res.status,
          );
          if (!RETRIABLE_STATUS.has(res.status)) throw error;
          lastError = withRetryAfter(error, res.headers.get("retry-after"));
          continue;
        }

        // GraphQL は 200 でもエラーを返すので必ず中身を見る
        const payload = await res.json() as {
          data?: T;
          errors?: { message: string }[];
        };
        if (payload.errors?.length) {
          throw new LinearApiError(
            `Linear GraphQL エラー: ${payload.errors.map((e) => e.message).join("; ")}`,
          );
        }
        if (payload.data === undefined) {
          throw new LinearApiError("Linear API がデータを返しませんでした");
        }
        return payload.data;
      } catch (err) {
        if (err instanceof LinearApiError && !RETRIABLE_STATUS.has(err.status ?? 0)) throw err;
        lastError = err;
      }
    }
    throw lastError;
  }

  getViewer(): Promise<{ viewer: { id: string; name: string; email: string } }> {
    return this.request(VIEWER_QUERY);
  }

  /** 指定 Team の課題を全件取得する */
  async listTeamIssues(teamKey: string): Promise<LinearIssueRef[]> {
    const issues: LinearIssueRef[] = [];
    let after: string | undefined;
    for (;;) {
      const data = await this.request<{
        issues: {
          nodes: {
            id: string;
            identifier: string;
            description: string | null;
            parent: { id: string } | null;
          }[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      }>(ISSUES_QUERY, { key: teamKey, after });

      for (const node of data.issues.nodes) {
        issues.push({
          id: node.id,
          identifier: node.identifier,
          description: node.description,
          parentId: node.parent?.id ?? null,
        });
      }
      if (!data.issues.pageInfo.hasNextPage || !data.issues.pageInfo.endCursor) return issues;
      after = data.issues.pageInfo.endCursor;
    }
  }

  async setParent(issueId: string, parentId: string): Promise<boolean> {
    const data = await this.request<{ issueUpdate: { success: boolean } }>(
      SET_PARENT_MUTATION,
      { id: issueId, parentId },
    );
    return data.issueUpdate.success;
  }
}

function withRetryAfter(error: LinearApiError, header: string | null): unknown {
  const seconds = header ? Number(header) : NaN;
  if (Number.isFinite(seconds)) {
    return Object.assign(error, { retryAfterMs: Math.max(0, seconds * 1000) });
  }
  return error;
}

function backoffMs(attempt: number, lastError: unknown): number {
  const hinted = (lastError as { retryAfterMs?: number } | undefined)?.retryAfterMs;
  if (typeof hinted === "number") return hinted;
  return Math.min(500 * 2 ** (attempt - 1), 16_000) + Math.random() * 250;
}
