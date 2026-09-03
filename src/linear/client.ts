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
  teamKey: string;
  teamName: string;
}

const RETRIABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * Team を指定して課題を引く。
 *
 * `filter: { description: { contains: ... } }` で脚注のマーカーを検索すれば Team を
 * 指定せずに済むが、この検索は検索インデックス経由で書き込みに遅れて追従する。
 * 取り込み直後に実行するとインデックス未反映の課題が丸ごと漏れるため使わない
 * （実測で、取り込み直後の 182 件が 1 件も返らなかった）。
 */
const TEAM_ISSUES_QUERY = `
query TeamIssues($key: String!, $after: String) {
  issues(first: 100, after: $after, filter: { team: { key: { eq: $key } } }) {
    nodes { id identifier description parent { id } team { key name } }
    pageInfo { hasNextPage endCursor }
  }
}`;

const SET_PARENT_MUTATION = `
mutation SetParent($id: String!, $parentId: String!) {
  issueUpdate(id: $id, input: { parentId: $parentId }) { success }
}`;

const VIEWER_QUERY = `query Viewer { viewer { id name email } }`;

const ISSUE_COMMENTS_QUERY = `
query IssueComments($id: String!, $after: String) {
  issue(id: $id) {
    comments(first: 100, after: $after) {
      nodes { id createdAt }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const CREATE_COMMENT_MUTATION = `
mutation CreateComment($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { id } }
}`;

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

  /** Team のキーを一覧する（--team の指定を誤ったときの案内用） */
  async listTeamKeys(): Promise<{ key: string; name: string }[]> {
    const data = await this.request<{
      teams: { nodes: { key: string; name: string }[] };
    }>(`query Teams { teams(first: 250) { nodes { key name } } }`);
    return data.teams.nodes;
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
            team: { key: string; name: string } | null;
          }[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      }>(TEAM_ISSUES_QUERY, { key: teamKey, after });

      for (const node of data.issues.nodes) {
        issues.push({
          id: node.id,
          identifier: node.identifier,
          description: node.description,
          parentId: node.parent?.id ?? null,
          teamKey: node.team?.key ?? "",
          teamName: node.team?.name ?? "",
        });
      }
      if (!data.issues.pageInfo.hasNextPage || !data.issues.pageInfo.endCursor) return issues;
      after = data.issues.pageInfo.endCursor;
    }
  }

  /** 課題に付いている既存コメントの作成日時を集める（投入済み判定に使う） */
  async listCommentTimestamps(issueId: string): Promise<string[]> {
    const stamps: string[] = [];
    let after: string | undefined;
    for (;;) {
      const data = await this.request<{
        issue: {
          comments: {
            nodes: { id: string; createdAt: string }[];
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        } | null;
      }>(ISSUE_COMMENTS_QUERY, { id: issueId, after });

      const page = data.issue?.comments;
      if (!page) return stamps;
      for (const node of page.nodes) stamps.push(node.createdAt);
      if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) return stamps;
      after = page.pageInfo.endCursor;
    }
  }

  /**
   * コメントを投入する。`createdAt` に過去の時刻を渡すと元の投稿日時を再現できる。
   * 投稿者は API キーの持ち主になる（`createAsUser` は OAuth アプリ専用）。
   */
  async createComment(
    issueId: string,
    body: string,
    createdAt: string,
  ): Promise<boolean> {
    const data = await this.request<{ commentCreate: { success: boolean } }>(
      CREATE_COMMENT_MUTATION,
      { input: { issueId, body, createdAt, doNotSubscribeToIssue: true } },
    );
    return data.commentCreate.success;
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
