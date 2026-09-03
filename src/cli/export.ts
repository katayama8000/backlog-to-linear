import { parseArgs } from "@std/cli/parse-args";
import { basename, dirname, join } from "@std/path";
import { BacklogClient } from "../backlog/client.ts";
import { BACKLOG_STATUS_CLOSED, type BacklogComment, type BacklogIssue } from "../backlog/types.ts";
import { type LinearCsvRow, toCsv } from "../csv/writer.ts";
import { defaultClosedStatusIds, type LabelPrefixes, toCsvRow } from "../transform/issue.ts";
import { buildRelations } from "../transform/relations.ts";
import { buildCommentsFile } from "../transform/comments.ts";
import { ConfigError, rejectUnknownFlags, resolveCredentials } from "../config.ts";
import { info, mapPool, progress, progressDone, verbose, warn } from "../log.ts";

export const exportHelp = `b2l export --project PROJ [options]

  Backlog の課題を Linear CSV 形式で書き出す。取り込みは \`npx @linear/import\`
  の "Linear (CSV)" を使う。

  --project PROJ           対象プロジェクトキー（必須）
  --space xxx.backlog.jp   スペース（既定: 環境変数 BACKLOG_SPACE）
  --out PATH               出力先（既定: ./out/<PROJ>.csv）
  --open-only              完了以外の課題のみ
  --status 未対応,処理中     ステータス名で絞る
  --closed-status リリース済み,取り下げ
                           完了として扱う独自ステータス（既定の「完了」に追加）
  --started-status 対応中,レビュー中
                           対応中として扱うステータス（Linear で Started 種別になる）
  --updated-since 2025-01-01
  --split N                N 行ごとにファイルを分割する
  --include-comments       コメントを Description に埋め込む
  --comments-sidecar       コメントを <PROJ>.comments.json に書き出す
                           （取り込み後に b2l enrich --comments で本物のコメントとして投入）
  --comments-max N         埋め込むコメント数の上限（既定: 20、0 で無制限）
  --no-estimate            Estimate 列を空にする
  --no-completed           Completed 列を空にする
  --assignee email|name    Assignee 列に出す値（既定: email）
  --no-issue-links         本文中の課題キーを Backlog リンクに書き換えない
  --no-relations           親子関係のサイドカー (<PROJ>.relations.json) を出さない
  --label-prefix K=V       ラベル接頭辞を上書き（K は type/category/milestone）
  --dry-run                件数と警告だけ出して書き出さない
  --verbose`;

interface IssueWarning {
  issueKey: string;
  message: string;
}

export async function exportCommand(argv: string[]): Promise<number> {
  const args = parseArgs(argv, {
    string: [
      "space",
      "project",
      "out",
      "status",
      "updated-since",
      "split",
      "comments-max",
      "assignee",
      "closed-status",
      "started-status",
    ],
    boolean: [
      "open-only",
      "include-comments",
      "comments-sidecar",
      "estimate",
      "completed",
      "issue-links",
      "relations",
      "dry-run",
      "force",
      "verbose",
    ],
    collect: ["label-prefix"],
    unknown: rejectUnknownFlags([
      "space",
      "project",
      "out",
      "status",
      "updated-since",
      "split",
      "comments-max",
      "assignee",
      "closed-status",
      "started-status",
      "open-only",
      "include-comments",
      "comments-sidecar",
      "estimate",
      "completed",
      "issue-links",
      "relations",
      "dry-run",
      "force",
      "verbose",
      "label-prefix",
    ]),
    default: {
      estimate: true,
      completed: true,
      "issue-links": true,
      relations: true,
      "comments-max": "20",
      assignee: "email",
    },
  });

  if (!args.project) throw new ConfigError("--project PROJ を指定してください。");
  const { space, apiKey } = resolveCredentials(args.space);
  const client = new BacklogClient({ space, apiKey });

  const project = await client.getProject(args.project);
  if (project.textFormattingRule !== "markdown" && !args.force) {
    throw new ConfigError(
      `プロジェクトの記法が "${project.textFormattingRule}" です。この CLI は markdown 記法の` +
        "プロジェクトを対象にしています。Backlog 独自記法の本文は Linear 上で崩れます。" +
        "承知の上で続けるなら --force を付けてください。",
    );
  }

  const statuses = await client.getStatuses(project.projectKey);
  // Backlog API はステータスの種別を返さないので、独自ステータスの扱いは引数で宣言してもらう
  const closedStatusIds = new Set([
    ...defaultClosedStatusIds(),
    ...resolveStatusIds(statuses, args["closed-status"], "--closed-status"),
  ]);
  const startedStatusIds = new Set(
    resolveStatusIds(statuses, args["started-status"], "--started-status"),
  );
  for (const id of startedStatusIds) {
    if (closedStatusIds.has(id)) {
      const name = statuses.find((s) => s.id === id)?.name ?? String(id);
      warn(`ステータス "${name}" は完了扱いが優先されます（--started-status は無視されます）`);
    }
  }
  const statusId = resolveStatusFilter(statuses, args["open-only"], args.status, closedStatusIds);
  const query = {
    projectId: project.id,
    statusId,
    updatedSince: args["updated-since"],
  };

  const total = await client.countIssues(query);
  info(`${project.projectKey}: 対象 ${total} 件を取得します`);

  const issues: BacklogIssue[] = [];
  for await (const issue of client.iterIssues(query)) {
    issues.push(issue);
    progress(`課題を取得中… ${issues.length}/${total}`);
  }
  progressDone();
  verbose(`取得した課題: ${issues.length} 件`);

  // 親課題 ID から課題キーを引くための対応表（Backlog は parentIssueId しか返さない）
  const issueKeyById = new Map(issues.map((issue) => [issue.id, issue.issueKey]));

  const commentsByIssue = new Map<string, BacklogComment[]>();
  const needComments = args["include-comments"] || args["comments-sidecar"];
  if (needComments) {
    let done = 0;
    await mapPool(issues, 4, async (issue) => {
      commentsByIssue.set(issue.issueKey, await client.getComments(issue.issueKey));
      progress(`コメントを取得中… ${++done}/${issues.length}`);
    });
    progressDone();
  }

  const opts = {
    spaceUrl: client.spaceUrl,
    projectKey: project.projectKey,
    issueLinks: args["issue-links"],
    includeComments: args["include-comments"],
    commentsMax: parseIntOr(args["comments-max"], 20),
    issueKeyById,
    labelPrefixes: resolveLabelPrefixes(args["label-prefix"] as string[] | undefined),
    assigneeField: resolveAssigneeField(args.assignee),
    estimate: args.estimate,
    completed: args.completed,
    closedStatusIds,
    startedStatusIds,
  };

  const rows: LinearCsvRow[] = [];
  const warnings: IssueWarning[] = [];
  for (const issue of issues) {
    const result = toCsvRow(issue, commentsByIssue.get(issue.issueKey) ?? [], opts);
    rows.push(result.row);
    for (const message of result.warnings) {
      warnings.push({ issueKey: issue.issueKey, message });
    }
  }

  const outPath = args.out ?? join("out", `${project.projectKey}.csv`);
  const split = args.split ? parseIntOr(args.split, 0) : 0;
  const chunks = split > 0 ? chunk(rows, split) : [rows];

  const relations = buildRelations(project.projectKey, issues);

  if (args["dry-run"]) {
    info(`(dry-run) ${rows.length} 行、${chunks.length} ファイル分を書き出す予定です`);
    if (args["comments-sidecar"]) {
      const comments = buildCommentsFile(project.projectKey, commentsByIssue);
      const total = comments.issues.reduce((n, i) => n + i.comments.length, 0);
      info(`(dry-run) コメント ${total} 件（${comments.issues.length} 課題）を書き出す予定です`);
    }
    if (args.relations && relations.parents.length > 0) {
      info(`(dry-run) 親子関係 ${relations.parents.length} 組をサイドカーに書き出す予定です`);
    }
  } else {
    await Deno.mkdir(dirname(outPath), { recursive: true });
    await Deno.mkdir(join(dirname(outPath), "sidecars"), { recursive: true });
    for (const [index, part] of chunks.entries()) {
      const path = chunks.length === 1 ? outPath : withSuffix(outPath, `.part${index + 1}`);
      await Deno.writeTextFile(path, toCsv(part));
      info(`書き出しました: ${path} (${part.length} 行)`);
    }
    if (args.relations && relations.parents.length > 0) {
      const path = sidecarPath(outPath, ".relations.json");
      await Deno.writeTextFile(path, `${JSON.stringify(relations, null, 2)}\n`);
      info(`親子関係: ${path} (${relations.parents.length} 組)`);
    }
    if (args["comments-sidecar"]) {
      const comments = buildCommentsFile(project.projectKey, commentsByIssue);
      const path = sidecarPath(outPath, ".comments.json");
      await Deno.writeTextFile(path, `${JSON.stringify(comments, null, 2)}\n`);
      const total = comments.issues.reduce((n, i) => n + i.comments.length, 0);
      info(`コメント: ${path} (${comments.issues.length} 課題 / ${total} 件)`);
    }
    await writeReport(outPath, project.projectKey, rows.length, warnings);
  }

  summarize(rows, warnings, args.relations ? relations.parents.length : 0);
  return 0;
}

/** カンマ区切りのステータス名を ID に解決する。空なら空配列。 */
export function resolveStatusIds(
  statuses: { id: number; name: string }[],
  names: string | undefined,
  flag: string,
): number[] {
  if (!names) return [];
  return names.split(",").map((s) => s.trim()).filter(Boolean).map((name) => {
    const found = statuses.find((s) => s.name === name);
    if (!found) {
      throw new ConfigError(
        `${flag}: ステータス "${name}" が見つかりません。存在するのは: ${
          statuses.map((s) => s.name).join(", ")
        }`,
      );
    }
    return found.id;
  });
}

export function resolveStatusFilter(
  statuses: { id: number; name: string }[],
  openOnly: boolean | undefined,
  statusNames: string | undefined,
  closedStatusIds: ReadonlySet<number> = new Set([BACKLOG_STATUS_CLOSED]),
): number[] | undefined {
  if (statusNames) return resolveStatusIds(statuses, statusNames, "--status");
  if (openOnly) {
    // Backlog の課題 API に「除外」の指定はないので、完了以外を列挙する。
    // 独自ステータスも（--closed-status で完了と宣言されていなければ）対象に含まれる。
    return statuses.map((s) => s.id).filter((id) => !closedStatusIds.has(id));
  }
  return undefined;
}

export function resolveAssigneeField(value: string | undefined): "email" | "name" {
  if (value === undefined || value === "email") return "email";
  if (value === "name") return "name";
  throw new ConfigError(`--assignee は email か name です: ${value}`);
}

export function resolveLabelPrefixes(overrides: string[] | undefined): LabelPrefixes {
  const prefixes: LabelPrefixes = {
    issueType: "type/",
    category: "category/",
    milestone: "milestone/",
  };
  const keys: Record<string, keyof LabelPrefixes> = {
    type: "issueType",
    issuetype: "issueType",
    category: "category",
    milestone: "milestone",
  };
  for (const override of overrides ?? []) {
    const separator = override.indexOf("=");
    if (separator < 0) {
      throw new ConfigError(`--label-prefix は KEY=VALUE 形式です: ${override}`);
    }
    const key = keys[override.slice(0, separator).toLowerCase()];
    if (!key) {
      throw new ConfigError(
        `--label-prefix のキーは type/category/milestone のいずれかです: ${override}`,
      );
    }
    prefixes[key] = override.slice(separator + 1);
  }
  return prefixes;
}

async function writeReport(
  outPath: string,
  projectKey: string,
  rowCount: number,
  warnings: IssueWarning[],
): Promise<void> {
  const path = sidecarPath(outPath, ".report.md");
  const lines = [
    `# ${projectKey} export report`,
    "",
    `- 書き出した行数: ${rowCount}`,
    `- 警告: ${warnings.length}`,
    "",
  ];
  if (warnings.length > 0) {
    lines.push("## 警告", "");
    for (const w of warnings) lines.push(`- ${w.issueKey}: ${w.message}`);
    lines.push("");
  }
  await Deno.writeTextFile(path, lines.join("\n"));
  info(`レポート: ${path}`);
}

function summarize(rows: LinearCsvRow[], warnings: IssueWarning[], parentCount: number): void {
  const completedCount = rows.filter((r) => r.Completed).length;
  const startedCount = rows.filter((r) => r.Started).length;
  const noAssignee = rows.filter((r) => !r.Assignee).length;
  const assignees = new Set(rows.map((r) => r.Assignee).filter(Boolean));
  const statuses = new Set(rows.map((r) => r.Status).filter(Boolean));
  const labels = new Set(rows.flatMap((r) => (r.Labels ?? "").split(", ")).filter(Boolean));

  info("");
  info(`課題: ${rows.length} 件 / 担当者未設定: ${noAssignee} 件`);
  info(`ステータス: ${[...statuses].join(", ") || "-"}`);
  info(
    `完了扱い (Completed 列あり): ${completedCount} 件 / 対応中扱い (Started 列あり): ${startedCount} 件`,
  );
  // importer はこの文字列で Linear ユーザーを突合するので、目視できるよう並べる
  info(`担当者 (Linear 側と突合される値): ${[...assignees].join(", ") || "-"}`);
  info(`ラベル: ${labels.size} 種`);
  if (warnings.length > 0) {
    warn(`${warnings.length} 件の警告があります（report.md を確認してください）`);
  }
  info("");
  info(
    '次の手順: `npx @linear/import` を実行し "Linear (CSV)" を選んでこのファイルを指定してください。',
  );
  if (parentCount > 0) {
    info(
      "そのあと `b2l enrich --project <PROJ>` を実行すると、" +
        `親子課題 ${parentCount} 組を sub-issue として張り直せます。`,
    );
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks.length > 0 ? chunks : [[]];
}

function withSuffix(path: string, suffix: string): string {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? `${path}${suffix}` : `${path.slice(0, dot)}${suffix}${path.slice(dot)}`;
}

/**
 * サイドカーは CSV と同じディレクトリに置かない。
 * `npx @linear/import` のファイル選択はディレクトリ内の全ファイルを並べるため、
 * 隣に .json があると CSV と間違えて選ばれる（実際に選ばれてクラッシュした）。
 *
 * out/PROJ.csv → out/sidecars/PROJ.relations.json
 */
export function sidecarPath(csvPath: string, extension: string): string {
  const dir = dirname(csvPath);
  const base = basename(csvPath).replace(/\.[^.]*$/, "");
  return join(dir, "sidecars", `${base}${extension}`);
}

function parseIntOr(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
