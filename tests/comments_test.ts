import { assertEquals } from "@std/assert";
import { buildCommentsFile, formatCommentBody } from "../src/transform/comments.ts";
import { makeComment } from "./fixtures/issue.ts";

Deno.test("課題キー順にコメントを並べたサイドカーを作る", () => {
  const map = new Map([
    ["PROJ-2", [makeComment({ id: 2, content: "b" })]],
    ["PROJ-1", [makeComment({ id: 1, content: "a" })]],
  ]);
  const file = buildCommentsFile("PROJ", map, new Date("2026-09-03T00:00:00Z"));
  assertEquals(file.projectKey, "PROJ");
  assertEquals(file.generatedAt, "2026-09-03T00:00:00.000Z");
  assertEquals(file.issues.map((i) => i.key), ["PROJ-1", "PROJ-2"]);
  assertEquals(file.issues[0].comments, [{
    id: 1,
    author: "山田太郎",
    created: "2024-01-05T09:00:00Z",
    body: "a",
  }]);
});

Deno.test("コメントが無い課題はサイドカーに入れない", () => {
  const file = buildCommentsFile("PROJ", new Map([["PROJ-1", []]]));
  assertEquals(file.issues, []);
});

Deno.test("投稿者は本文の先頭に置く（createAsUser は使えないため）", () => {
  assertEquals(
    formatCommentBody({ author: "山田太郎", body: "確認しました。" }),
    "**山田太郎**\n\n確認しました。",
  );
});

Deno.test("投稿日時は本文に入れない（createdAt で再現できるため）", () => {
  const body = formatCommentBody({ author: "山田太郎", body: "本文" });
  assertEquals(body.includes("2024"), false);
});
