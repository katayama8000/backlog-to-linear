import { assertEquals, assertStringIncludes } from "@std/assert";
import { buildDescription, linkifyIssueKeys } from "../src/transform/description.ts";
import { makeComment, makeIssue } from "./fixtures/issue.ts";

const SPACE = "https://xxx.backlog.jp";

const baseOpts = {
  spaceUrl: SPACE,
  projectKey: "PROJ",
  issueLinks: true,
  includeComments: false,
  commentsMax: 20,
  issueKeyById: new Map<number, string>(),
};

Deno.test("課題キーを Backlog リンクに書き換える", () => {
  assertEquals(
    linkifyIssueKeys("PROJ-12 を参照", "PROJ", SPACE),
    `[PROJ-12](${SPACE}/view/PROJ-12) を参照`,
  );
});

Deno.test("既にリンクや URL になっているものは触らない", () => {
  const linked = `[PROJ-12](${SPACE}/view/PROJ-12)`;
  assertEquals(linkifyIssueKeys(linked, "PROJ", SPACE), linked);
  const url = `${SPACE}/view/PROJ-12`;
  assertEquals(linkifyIssueKeys(url, "PROJ", SPACE), url);
});

Deno.test("コードブロックとインラインコードの中は触らない", () => {
  const fenced = "```\nPROJ-1\n```";
  assertEquals(linkifyIssueKeys(fenced, "PROJ", SPACE), fenced);
  assertEquals(linkifyIssueKeys("`PROJ-1`", "PROJ", SPACE), "`PROJ-1`");
});

Deno.test("他プロジェクトのキーや語の一部は書き換えない", () => {
  assertEquals(linkifyIssueKeys("OTHER-1", "PROJ", SPACE), "OTHER-1");
  assertEquals(linkifyIssueKeys("XPROJ-1", "PROJ", SPACE), "XPROJ-1");
  assertEquals(linkifyIssueKeys("PROJ-1a", "PROJ", SPACE), "PROJ-1a");
});

Deno.test("脚注に出典と Backlog 固有の情報を残す", () => {
  const issue = makeIssue({ estimatedHours: 3, actualHours: 5, dueDate: "2024-03-01T00:00:00Z" });
  const { text } = buildDescription(issue, [], baseOpts);
  assertStringIncludes(text, "手順:");
  assertStringIncludes(text, `Migrated from Backlog [PROJ-1](${SPACE}/view/PROJ-1)`);
  assertStringIncludes(text, "登録者: 佐藤花子");
  assertStringIncludes(text, "予定: 3h");
  assertStringIncludes(text, "実績: 5h");
  assertStringIncludes(text, "期限日: 2024-03-01");
});

Deno.test("親課題は課題キーに解決してリンクする", () => {
  const issue = makeIssue({ parentIssueId: 900 });
  const { text, warnings } = buildDescription(issue, [], {
    ...baseOpts,
    issueKeyById: new Map([[900, "PROJ-100"]]),
  });
  assertStringIncludes(text, `親課題: [PROJ-100](${SPACE}/view/PROJ-100)`);
  assertEquals(warnings, []);
});

Deno.test("親課題が書き出し対象外なら警告する", () => {
  const issue = makeIssue({ parentIssueId: 900 });
  const { text, warnings } = buildDescription(issue, [], baseOpts);
  assertStringIncludes(text, "親課題: Backlog 課題 ID 900");
  assertEquals(warnings.length, 1);
});

Deno.test("添付ファイルは名前だけ脚注に残す", () => {
  const issue = makeIssue({ attachments: [{ id: 1, name: "design.pdf", size: 100 }] });
  const { text } = buildDescription(issue, [], baseOpts);
  assertStringIncludes(text, "添付ファイル (Backlog に残っています): design.pdf");
});

Deno.test("コメントは既定で埋め込まない", () => {
  const { text } = buildDescription(makeIssue(), [makeComment()], baseOpts);
  assertEquals(text.includes("確認しました。"), false);
});

Deno.test("include-comments で折りたたみブロックとして埋め込む", () => {
  const comments = [
    makeComment({ id: 1, content: "1件目", created: "2024-01-05T09:00:00Z" }),
    makeComment({ id: 2, content: "2件目", created: "2024-01-06T09:00:00Z" }),
  ];
  const { text } = buildDescription(makeIssue(), comments, {
    ...baseOpts,
    includeComments: true,
  });
  assertStringIncludes(text, "<details><summary>Backlog のコメント (2)</summary>");
  assertStringIncludes(text, "**山田太郎** — 2024-01-05");
  assertStringIncludes(text, "1件目");
  assertStringIncludes(text, "2件目");
  assertStringIncludes(text, "</details>");
});

Deno.test("comments-max を超えた分は新しい方を残して省略を明記する", () => {
  const comments = [1, 2, 3].map((n) =>
    makeComment({ id: n, content: `c${n}`, created: `2024-01-0${n}T09:00:00Z` })
  );
  const { text } = buildDescription(makeIssue(), comments, {
    ...baseOpts,
    includeComments: true,
    commentsMax: 2,
  });
  assertEquals(text.includes("c1"), false);
  assertStringIncludes(text, "c2");
  assertStringIncludes(text, "c3");
  assertStringIncludes(text, "_古い 1 件は省略しています。_");
});

Deno.test("本文があるときは脚注の前に区切り線を置く", () => {
  const { text } = buildDescription(makeIssue({ description: "本文" }), [], baseOpts);
  assertStringIncludes(text, "本文\n\n---\nMigrated from Backlog");
});

Deno.test("本文が空なら区切り線を出さない（冒頭に水平線だけ出るのを避ける）", () => {
  const { text } = buildDescription(makeIssue({ description: null }), [], baseOpts);
  assertEquals(text.startsWith("Migrated from Backlog"), true);
});

Deno.test("本文が空でもコメントがあれば区切り線を置く", () => {
  const { text } = buildDescription(makeIssue({ description: "" }), [makeComment()], {
    ...baseOpts,
    includeComments: true,
  });
  assertEquals(text.startsWith("<details>"), true);
  assertStringIncludes(text, "</details>\n\n---\nMigrated from Backlog");
});
