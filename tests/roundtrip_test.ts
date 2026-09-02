/**
 * 生成した CSV を `@linear/import` の LinearCsvImporter と同じ手順で読み直し、
 * 意図した値として解釈されることを確認する（importer 側の実装を写したもの）。
 */
import { assertEquals } from "@std/assert";
import { toCsv } from "../src/csv/writer.ts";
import { defaultClosedStatusIds, toCsvRow } from "../src/transform/issue.ts";
import { makeComment, makeIssue } from "./fixtures/issue.ts";

/** RFC4180 の最小パーサ（csvtojson が行う解釈の確認用） */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\r" && text[i + 1] === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
    } else field += char;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows;
  return body.map((cells) => Object.fromEntries(header.map((name, i) => [name, cells[i] ?? ""])));
}

/** importer の stripLeadingSingleQuote */
function stripLeadingSingleQuote(input: string): string {
  return input.replace(/^'([+\-=@∑√∏<>＜＞≤≥＝≠±÷×])/, "$1");
}

/** importer の mapPriority */
const PRIORITY_MAP: Record<string, number> = {
  "No priority": 0,
  Urgent: 1,
  High: 2,
  Medium: 3,
  Low: 4,
};

interface ImportedIssue {
  title: string;
  description: string;
  priority: number;
  status: string;
  assigneeId: string;
  labels: string[];
  createdAt?: Date;
  completedAt?: Date;
  estimate?: number;
}

/** LinearCsvImporter.import と同じ変換 */
function simulateImport(csv: string): ImportedIssue[] {
  return parseCsv(csv)
    .filter((row) => !row.Archived)
    .map((row) => ({
      title: stripLeadingSingleQuote(row.Title),
      description: stripLeadingSingleQuote(row.Description),
      priority: PRIORITY_MAP[row.Priority] ?? 0,
      status: row.Status,
      assigneeId: row.Assignee,
      labels: row.Labels ? row.Labels.split(", ").filter(Boolean) : [],
      createdAt: row.Created ? new Date(row.Created) : undefined,
      completedAt: row.Completed ? new Date(row.Completed) : undefined,
      estimate: Number.parseInt(row.Estimate, 10) || undefined,
    }));
}

const opts = {
  spaceUrl: "https://xxx.backlog.jp",
  projectKey: "PROJ",
  issueLinks: true,
  includeComments: true,
  commentsMax: 20,
  issueKeyById: new Map<number, string>(),
  labelPrefixes: { issueType: "type/", category: "category/", milestone: "milestone/" },
  assigneeField: "email" as const,
  estimate: true,
  completed: true,
  closedStatusIds: defaultClosedStatusIds(),
};

Deno.test("importer が全行を読み、値が壊れない", () => {
  const issues = [
    makeIssue({
      id: 1,
      issueKey: "PROJ-1",
      // カンマ・引用符・改行・箇条書き（先頭 "-"）を同時に含む最悪ケース
      summary: 'ログイン, "できない"',
      description: '- 手順1\n- 手順2 で "落ちる"\n\n| a | b |\n| --- | --- |\n| 1 | 2 |',
      status: { id: 4, name: "完了" },
      estimatedHours: 2.4,
      category: [{ id: 1, name: "フロント" }],
      milestone: [{ id: 2, name: "v1.0" }],
    }),
    makeIssue({ id: 2, issueKey: "PROJ-2", assignee: null, priority: { id: 2, name: "高" } }),
  ];
  const comments = [makeComment({ content: "PROJ-2 も関係します。" })];

  const rows = issues.map((issue) => toCsvRow(issue, comments, opts).row);
  const imported = simulateImport(toCsv(rows));

  assertEquals(imported.length, 2);

  const [first, second] = imported;
  assertEquals(first.title, 'ログイン, "できない"');
  assertEquals(first.status, "完了");
  assertEquals(first.assigneeId, "yamada@example.com");
  assertEquals(first.priority, 3);
  assertEquals(first.estimate, 2);
  assertEquals(first.labels, ["type/バグ", "category/フロント", "milestone/v1.0"]);
  assertEquals(first.createdAt?.toISOString(), "2024-01-01T09:00:00.000Z");
  assertEquals(first.completedAt?.toISOString(), "2024-02-01T09:00:00.000Z");
  // 箇条書きの "-" が ' を剥がされて元に戻り、表や引用符も保たれる
  assertEquals(first.description.startsWith('- 手順1\n- 手順2 で "落ちる"'), true);
  assertEquals(first.description.includes("| a | b |"), true);
  assertEquals(
    first.description.includes(
      "Migrated from Backlog [PROJ-1](https://xxx.backlog.jp/view/PROJ-1)",
    ),
    true,
  );
  // コメント内の課題キーもリンクになる
  assertEquals(
    first.description.includes("[PROJ-2](https://xxx.backlog.jp/view/PROJ-2)"),
    true,
  );

  assertEquals(second.priority, 2);
  assertEquals(second.assigneeId, "");
  assertEquals(second.completedAt, undefined);
});
