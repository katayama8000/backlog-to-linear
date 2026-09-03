import type { BacklogComment } from "../backlog/types.ts";

/**
 * export 時に書き出すコメントのサイドカー。
 * Linear CSV にはコメントの列がないため、取り込み後に `b2l enrich --comments` が
 * このファイルを使って本物のコメントとして投入する。
 */
export interface CommentsFile {
  projectKey: string;
  generatedAt: string;
  issues: {
    key: string;
    comments: { id: number; author: string; created: string; body: string }[];
  }[];
}

export function buildCommentsFile(
  projectKey: string,
  commentsByIssue: ReadonlyMap<string, readonly BacklogComment[]>,
  now = new Date(),
): CommentsFile {
  const issues: CommentsFile["issues"] = [];
  // 課題キーの並びを安定させておくと差分が読みやすい
  for (const key of [...commentsByIssue.keys()].sort()) {
    const comments = commentsByIssue.get(key) ?? [];
    if (comments.length === 0) continue;
    issues.push({
      key,
      comments: comments.map((c) => ({
        id: c.id,
        author: c.createdUser?.name ?? "不明",
        created: c.created,
        body: (c.content ?? "").replace(/\r\n/g, "\n").trimEnd(),
      })),
    });
  }
  return { projectKey, generatedAt: now.toISOString(), issues };
}

/**
 * Linear に投入するコメント本文。
 *
 * 投稿者は再現できない（`createAsUser` は OAuth アプリの actor=app モード専用で、
 * Personal API key では使えない）ため、原著者を本文の先頭に置く。
 * 投稿日時は commentCreate の `createdAt` で再現できるので本文には入れない。
 */
export function formatCommentBody(comment: { author: string; body: string }): string {
  return `**${comment.author}**\n\n${comment.body}`;
}
