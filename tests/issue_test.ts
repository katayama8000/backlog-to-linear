import { assertEquals } from "@std/assert";
import {
  buildLabels,
  defaultClosedStatusIds,
  mapPriority,
  sanitizeLabel,
  toCsvRow,
} from "../src/transform/issue.ts";
import { makeIssue } from "./fixtures/issue.ts";

const opts = {
  spaceUrl: "https://xxx.backlog.jp",
  projectKey: "PROJ",
  issueLinks: true,
  includeComments: false,
  commentsMax: 20,
  issueKeyById: new Map<number, string>(),
  labelPrefixes: { issueType: "type/", category: "category/", milestone: "milestone/" },
  assigneeField: "email" as const,
  estimate: true,
  completed: true,
  closedStatusIds: defaultClosedStatusIds(),
  startedStatusIds: new Set<number>(),
};

Deno.test("優先度は Linear の文字列表現に変換する", () => {
  assertEquals(mapPriority(2), "High");
  assertEquals(mapPriority(3), "Medium");
  assertEquals(mapPriority(4), "Low");
  // Backlog に Urgent 相当はなく、未設定は No priority
  assertEquals(mapPriority(null), "No priority");
  assertEquals(mapPriority(undefined), "No priority");
});

Deno.test("種別・カテゴリー・マイルストーンをラベル化する", () => {
  const issue = makeIssue({
    issueType: { id: 1, name: "バグ" },
    category: [{ id: 1, name: "フロントエンド" }, { id: 2, name: "API" }],
    milestone: [{ id: 3, name: "v1.0" }],
  });
  assertEquals(buildLabels(issue, opts.labelPrefixes), [
    "type/バグ",
    "category/フロントエンド",
    "category/API",
    "milestone/v1.0",
  ]);
});

Deno.test("Labels 列は , 区切りなのでラベル名のカンマを置換する", () => {
  assertEquals(sanitizeLabel("a,b"), "a_b");
  const issue = makeIssue({ issueType: { id: 1, name: "設計, 実装" } });
  assertEquals(toCsvRow(issue, [], opts).row.Labels, "type/設計_ 実装");
});

Deno.test("ステータスは Backlog の名前をそのまま出す", () => {
  const { row } = toCsvRow(makeIssue(), [], opts);
  assertEquals(row.Status, "未対応");
  assertEquals(row.Creator, "佐藤花子");
});

Deno.test("Assignee は既定でメールアドレス（importer がメール優先で突合するため）", () => {
  const { row } = toCsvRow(makeIssue(), [], opts);
  assertEquals(row.Assignee, "yamada@example.com");
});

Deno.test("--assignee name なら表示名を出す", () => {
  const { row } = toCsvRow(makeIssue(), [], { ...opts, assigneeField: "name" });
  assertEquals(row.Assignee, "山田太郎");
});

Deno.test("メールアドレスが非公開なら表示名にフォールバックして警告する", () => {
  const issue = makeIssue({
    assignee: { id: 10, userId: "yamada", name: "山田太郎", mailAddress: null },
  });
  const { row, warnings } = toCsvRow(issue, [], opts);
  assertEquals(row.Assignee, "山田太郎");
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0].includes("メールアドレスが取得できない"), true);
});

Deno.test("Archived は必ず空（値が入ると importer が行をスキップする）", () => {
  const { row } = toCsvRow(makeIssue(), [], opts);
  assertEquals(row.Archived, "");
});

Deno.test("Created は Backlog の作成日時を保持する", () => {
  const { row } = toCsvRow(makeIssue(), [], opts);
  assertEquals(row.Created, "2024-01-01T09:00:00Z");
});

Deno.test("完了状態のときだけ Completed を埋める（updated で近似）", () => {
  const open = toCsvRow(makeIssue({ status: { id: 1, name: "未対応" } }), [], opts);
  assertEquals(open.row.Completed, "");

  const closed = toCsvRow(makeIssue({ status: { id: 4, name: "完了" } }), [], opts);
  assertEquals(closed.row.Completed, "2024-02-01T09:00:00Z");

  const suppressed = toCsvRow(makeIssue({ status: { id: 4, name: "完了" } }), [], {
    ...opts,
    completed: false,
  });
  assertEquals(suppressed.row.Completed, "");
});

Deno.test("Estimate は整数に丸める / --no-estimate で空にする", () => {
  assertEquals(toCsvRow(makeIssue({ estimatedHours: 2.5 }), [], opts).row.Estimate, "3");
  assertEquals(toCsvRow(makeIssue({ estimatedHours: null }), [], opts).row.Estimate, "");
  assertEquals(
    toCsvRow(makeIssue({ estimatedHours: 3 }), [], { ...opts, estimate: false }).row.Estimate,
    "",
  );
});

Deno.test("担当者未設定は警告する", () => {
  const { row, warnings } = toCsvRow(makeIssue({ assignee: null }), [], opts);
  assertEquals(row.Assignee, "");
  assertEquals(warnings, ["担当者が未設定です"]);
});

Deno.test("独自ステータスを完了扱いにできる（Completed 列を埋める）", () => {
  const issue = makeIssue({ status: { id: 7, name: "リリース済み" } });
  // 宣言しなければ未完了のまま
  assertEquals(toCsvRow(issue, [], opts).row.Completed, "");
  const declared = toCsvRow(issue, [], {
    ...opts,
    closedStatusIds: new Set([4, 7]),
  });
  assertEquals(declared.row.Completed, "2024-02-01T09:00:00Z");
});

Deno.test("独自ステータスを対応中扱いにできる（Started 列を埋める）", () => {
  const issue = makeIssue({ status: { id: 8, name: "レビュー中" } });
  assertEquals(toCsvRow(issue, [], opts).row.Started, "");
  const declared = toCsvRow(issue, [], { ...opts, startedStatusIds: new Set([8]) });
  // 開始日がなければ登録日で近似する
  assertEquals(declared.row.Started, "2024-01-01T09:00:00Z");
});

Deno.test("開始日があれば Started にそれを使う", () => {
  const issue = makeIssue({
    status: { id: 8, name: "レビュー中" },
    startDate: "2024-01-15T00:00:00Z",
  });
  const { row } = toCsvRow(issue, [], { ...opts, startedStatusIds: new Set([8]) });
  assertEquals(row.Started, "2024-01-15T00:00:00Z");
});

Deno.test("完了と対応中の両方に該当したら完了を優先する", () => {
  const issue = makeIssue({ status: { id: 7, name: "リリース済み" } });
  const { row } = toCsvRow(issue, [], {
    ...opts,
    closedStatusIds: new Set([4, 7]),
    startedStatusIds: new Set([7]),
  });
  assertEquals(row.Completed, "2024-02-01T09:00:00Z");
  // importer は completedAt を先に見るので Started は出さない
  assertEquals(row.Started, "");
});
