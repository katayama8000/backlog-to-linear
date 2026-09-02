import type { BacklogComment, BacklogIssue } from "../backlog/types.ts";

export interface DescriptionOptions {
  /** 例: https://xxx.backlog.jp */
  spaceUrl: string;
  projectKey: string;
  /** 本文中の課題キーを Backlog リンクへ書き換えるか */
  issueLinks: boolean;
  /** コメントを本文末尾に埋め込むか */
  includeComments: boolean;
  /** 埋め込むコメントの最大件数（新しいものを残す） */
  commentsMax: number;
  /** 親課題 ID → 課題キーの対応表 */
  issueKeyById: ReadonlyMap<number, string>;
}

export interface BuiltDescription {
  text: string;
  warnings: string[];
}

/**
 * 脚注に埋める出典行の書式。CSV 取り込み後に `b2l enrich` が
 * Linear の課題と Backlog の課題キーを突き合わせる唯一の手がかりなので、
 * この形は変えないこと（変えると既に取り込んだ課題を追えなくなる）。
 */
export const MIGRATION_MARKER = "Migrated from Backlog";

/** 脚注から Backlog の課題キーを読み戻す */
export function parseBacklogKey(description: string | null | undefined): string | null {
  const match = (description ?? "").match(
    new RegExp(String.raw`${MIGRATION_MARKER}\s+\[?([A-Za-z0-9_]+-\d+)\]?`),
  );
  return match?.[1] ?? null;
}

export function issueUrl(spaceUrl: string, issueKey: string): string {
  return `${spaceUrl}/view/${issueKey}`;
}

/**
 * コードブロック・インラインコードの外側だけを変換する。
 */
export function mapOutsideCode(text: string, fn: (segment: string) => string): string {
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  return parts.map((part, i) => (i % 2 === 1 ? part : fn(part))).join("");
}

/**
 * 本文中の `PROJ-123` を Backlog へのリンクに書き換える。
 * 既にリンクになっているもの、コード内のもの、他の語の一部は触らない。
 */
export function linkifyIssueKeys(
  text: string,
  projectKey: string,
  spaceUrl: string,
): string {
  const pattern = new RegExp(
    String.raw`(?<![\w\-/\[])(${escapeRegExp(projectKey)}-\d+)(?![\w\-])`,
    "g",
  );
  return mapOutsideCode(
    text,
    (segment) =>
      segment.replace(pattern, (match, key: string, offset: number) => {
        // `[PROJ-1]` のようにリンクテキスト/参照になっている場合は書き換えない
        if (segment.slice(offset + match.length).startsWith("]")) return match;
        return `[${key}](${issueUrl(spaceUrl, key)})`;
      }),
  );
}

export function buildDescription(
  issue: BacklogIssue,
  comments: readonly BacklogComment[],
  opts: DescriptionOptions,
): BuiltDescription {
  const warnings: string[] = [];
  const blocks: string[] = [];

  let body = (issue.description ?? "").replace(/\r\n/g, "\n").trimEnd();
  if (body) {
    if (opts.issueLinks) body = linkifyIssueKeys(body, opts.projectKey, opts.spaceUrl);
    blocks.push(body);
  }

  if (opts.includeComments && comments.length > 0) {
    blocks.push(renderComments(comments, opts));
  }

  // 本文もコメントもないときは区切り線を出さない（冒頭に水平線だけ出るのを避ける）
  blocks.push(renderFooter(issue, opts, warnings, blocks.length > 0));
  return { text: blocks.join("\n\n"), warnings };
}

function renderComments(
  comments: readonly BacklogComment[],
  opts: DescriptionOptions,
): string {
  const kept = opts.commentsMax > 0 ? comments.slice(-opts.commentsMax) : [...comments];
  const omitted = comments.length - kept.length;

  const lines = [
    `<details><summary>Backlog のコメント (${comments.length})</summary>`,
    "",
  ];
  if (omitted > 0) lines.push(`_古い ${omitted} 件は省略しています。_`, "");
  for (const comment of kept) {
    const author = comment.createdUser?.name ?? "不明";
    let content = (comment.content ?? "").replace(/\r\n/g, "\n").trimEnd();
    if (opts.issueLinks) content = linkifyIssueKeys(content, opts.projectKey, opts.spaceUrl);
    lines.push(`**${author}** — ${formatDate(comment.created)}`, "", content, "");
  }
  lines.push("</details>");
  return lines.join("\n");
}

function renderFooter(
  issue: BacklogIssue,
  opts: DescriptionOptions,
  warnings: string[],
  withSeparator: boolean,
): string {
  const lines = withSeparator ? ["---"] : [];
  lines.push(`${MIGRATION_MARKER} [${issue.issueKey}](${issueUrl(opts.spaceUrl, issue.issueKey)})`);

  const meta: string[] = [];
  if (issue.createdUser?.name) meta.push(`登録者: ${issue.createdUser.name}`);
  meta.push(`登録日: ${formatDate(issue.created)}`);
  if (issue.estimatedHours != null) meta.push(`予定: ${issue.estimatedHours}h`);
  if (issue.actualHours != null) meta.push(`実績: ${issue.actualHours}h`);
  if (issue.startDate) meta.push(`開始日: ${formatDate(issue.startDate)}`);
  if (issue.dueDate) meta.push(`期限日: ${formatDate(issue.dueDate)}`);
  lines.push(meta.join(" / "));

  if (issue.parentIssueId != null) {
    const parentKey = opts.issueKeyById.get(issue.parentIssueId);
    if (parentKey) {
      lines.push(`親課題: [${parentKey}](${issueUrl(opts.spaceUrl, parentKey)})`);
    } else {
      // 絞り込みで親が書き出し対象から漏れている場合
      lines.push(`親課題: Backlog 課題 ID ${issue.parentIssueId}`);
      warnings.push(`親課題 (ID ${issue.parentIssueId}) が書き出し対象に含まれていません`);
    }
  }

  if (issue.attachments.length > 0) {
    // 添付の実ファイルは CSV では運べないため、名前だけ残す
    const names = issue.attachments.map((a) => a.name).join(", ");
    lines.push(`添付ファイル (Backlog に残っています): ${names}`);
  }

  return lines.join("\n");
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().slice(0, 10);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
