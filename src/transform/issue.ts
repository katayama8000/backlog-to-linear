import {
  BACKLOG_PRIORITY,
  BACKLOG_STATUS_CLOSED,
  type BacklogComment,
  type BacklogIssue,
} from "../backlog/types.ts";
import type { LinearCsvRow } from "../csv/writer.ts";
import { buildDescription, type DescriptionOptions } from "./description.ts";

export interface LabelPrefixes {
  issueType: string;
  category: string;
  milestone: string;
}

export interface TransformOptions extends DescriptionOptions {
  labelPrefixes: LabelPrefixes;
  /**
   * Assignee 列に何を出すか。
   * importer は「小文字化したメール → 小文字化した表示名」の順で突合するため、
   * 既定はメール。Backlog と Linear で表示名が違っても当たる。
   */
  assigneeField: "email" | "name";
  /** Estimate 列を埋めるか（Linear 側で estimate 有効化が必要） */
  estimate: boolean;
  /** 完了状態の課題に Completed 列を埋めるか（Backlog に完了日時がないため updated で近似） */
  completed: boolean;
  /** 完了として扱うステータス ID（Completed 列を埋める） */
  closedStatusIds: ReadonlySet<number>;
  /**
   * 対応中として扱うステータス ID（Started 列を埋める）。
   * importer は状態を自動作成するとき Completed → Started → Backlog の順で種別を決めるため、
   * ここを指定しないと「対応中」相当の独自ステータスが Backlog 種別で作られる。
   */
  startedStatusIds: ReadonlySet<number>;
}

export interface TransformResult {
  row: LinearCsvRow;
  warnings: string[];
}

/** Backlog の優先度は 高/中/低 の3種のみ。Urgent に対応するものはない。 */
export function mapPriority(priorityId: number | null | undefined): string {
  switch (priorityId) {
    case BACKLOG_PRIORITY.HIGH:
      return "High";
    case BACKLOG_PRIORITY.MIDDLE:
      return "Medium";
    case BACKLOG_PRIORITY.LOW:
      return "Low";
    default:
      return "No priority";
  }
}

/** Linear CSV の Labels 列は `, ` 区切りなので、ラベル名にカンマを残せない。 */
export function sanitizeLabel(name: string): string {
  return name.replaceAll(",", "_").trim();
}

export function buildLabels(issue: BacklogIssue, prefixes: LabelPrefixes): string[] {
  const labels: string[] = [];
  if (issue.issueType?.name) {
    labels.push(`${prefixes.issueType}${sanitizeLabel(issue.issueType.name)}`);
  }
  for (const category of issue.category) {
    labels.push(`${prefixes.category}${sanitizeLabel(category.name)}`);
  }
  // Backlog のマイルストーンは milestone に入る（versions は「発生バージョン」）
  for (const milestone of issue.milestone) {
    labels.push(`${prefixes.milestone}${sanitizeLabel(milestone.name)}`);
  }
  return [...new Set(labels.filter((l) => l !== ""))];
}

export function toCsvRow(
  issue: BacklogIssue,
  comments: readonly BacklogComment[],
  opts: TransformOptions,
): TransformResult {
  const { text, warnings } = buildDescription(issue, comments, opts);
  const statusId = issue.status?.id;
  const isClosed = statusId != null && opts.closedStatusIds.has(statusId);
  // Completed が入っていれば importer 側で Started は見られないので、完了時は出さない
  const isStarted = !isClosed && statusId != null && opts.startedStatusIds.has(statusId);

  const assignee = resolveAssignee(issue, opts.assigneeField, warnings);

  return {
    row: {
      Id: "",
      Team: "",
      Title: issue.summary,
      Description: text,
      // 変換せず Backlog のステータス名を出す。取り込み時に対話でマッピングされる。
      Status: issue.status?.name ?? "",
      Estimate: opts.estimate && issue.estimatedHours != null
        ? String(Math.max(0, Math.round(issue.estimatedHours)))
        : "",
      Priority: mapPriority(issue.priority?.id),
      Project: "",
      Creator: issue.createdUser?.name ?? "",
      Assignee: assignee,
      Labels: buildLabels(issue, opts.labelPrefixes).join(", "),
      "Cycle Number": "",
      "Cycle Name": "",
      "Cycle Start": "",
      "Cycle End": "",
      Created: issue.created,
      Updated: issue.updated,
      // Backlog に「着手日時」はないので、開始日、無ければ登録日で近似する
      Started: isStarted ? (issue.startDate ?? issue.created) : "",
      Completed: opts.completed && isClosed ? issue.updated : "",
      Canceled: "",
      // 値が入っていると importer が行ごとスキップするため、必ず空
      Archived: "",
    },
    warnings,
  };
}

/**
 * importer は Assignee 列の文字列をメール→表示名の順で Linear ユーザーに突き合わせる。
 * 一致しなければ黙って未割り当てになるので、当たりやすいメールを既定にする。
 */
function resolveAssignee(
  issue: BacklogIssue,
  field: "email" | "name",
  warnings: string[],
): string {
  if (issue.assignee == null) {
    warnings.push("担当者が未設定です");
    return "";
  }
  if (field === "name") return issue.assignee.name;
  if (issue.assignee.mailAddress) return issue.assignee.mailAddress;
  // Backlog 側でメールアドレスが非公開の場合は表示名にフォールバックする
  warnings.push(
    `担当者 "${issue.assignee.name}" のメールアドレスが取得できないため表示名を出力します`,
  );
  return issue.assignee.name;
}

export function defaultClosedStatusIds(): Set<number> {
  return new Set([BACKLOG_STATUS_CLOSED]);
}
