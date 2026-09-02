import { assertEquals } from "@std/assert";
import { buildRelations } from "../src/transform/relations.ts";
import { parseBacklogKey } from "../src/transform/description.ts";
import { makeIssue } from "./fixtures/issue.ts";

Deno.test("親子関係を課題キーの組に変換する", () => {
  const issues = [
    makeIssue({ id: 1, issueKey: "PROJ-1" }),
    makeIssue({ id: 2, issueKey: "PROJ-2", parentIssueId: 1 }),
    makeIssue({ id: 3, issueKey: "PROJ-3", parentIssueId: 1 }),
  ];
  const relations = buildRelations("PROJ", issues, new Date("2026-09-02T00:00:00Z"));
  assertEquals(relations.projectKey, "PROJ");
  assertEquals(relations.generatedAt, "2026-09-02T00:00:00.000Z");
  assertEquals(relations.parents, [
    { child: "PROJ-2", parent: "PROJ-1" },
    { child: "PROJ-3", parent: "PROJ-1" },
  ]);
});

Deno.test("親が書き出し対象外なら組から落とす", () => {
  const issues = [makeIssue({ id: 2, issueKey: "PROJ-2", parentIssueId: 999 })];
  assertEquals(buildRelations("PROJ", issues).parents, []);
});

Deno.test("脚注から Backlog 課題キーを読み戻せる（enrich の突合キー）", () => {
  const description = [
    "本文",
    "",
    "---",
    "Migrated from Backlog [PROJ-123](https://xxx.backlog.jp/view/PROJ-123)",
    "登録者: 山田太郎",
  ].join("\n");
  assertEquals(parseBacklogKey(description), "PROJ-123");
});

Deno.test("脚注がなければ null（手で作られた課題を巻き込まない）", () => {
  assertEquals(parseBacklogKey("ふつうの課題です"), null);
  assertEquals(parseBacklogKey(null), null);
  assertEquals(parseBacklogKey(undefined), null);
});
