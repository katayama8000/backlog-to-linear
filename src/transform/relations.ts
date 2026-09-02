import type { BacklogIssue } from "../backlog/types.ts";

/**
 * export 時に書き出す親子関係のサイドカー。
 * Linear CSV には親を指定する列がないため、CSV 取り込み後に
 * `b2l enrich` がこのファイルを使って sub-issue を張り直す。
 */
export interface RelationsFile {
  projectKey: string;
  generatedAt: string;
  parents: { child: string; parent: string }[];
}

export function buildRelations(
  projectKey: string,
  issues: readonly BacklogIssue[],
  now = new Date(),
): RelationsFile {
  const keyById = new Map(issues.map((issue) => [issue.id, issue.issueKey]));
  const parents: { child: string; parent: string }[] = [];
  for (const issue of issues) {
    if (issue.parentIssueId == null) continue;
    const parent = keyById.get(issue.parentIssueId);
    // 親が書き出し対象外なら張れないので落とす（export 側で警告済み）
    if (parent) parents.push({ child: issue.issueKey, parent });
  }
  return { projectKey, generatedAt: now.toISOString(), parents };
}
