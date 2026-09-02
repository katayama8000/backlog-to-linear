import { assertEquals, assertThrows } from "@std/assert";
import {
  resolveAssigneeField,
  resolveLabelPrefixes,
  resolveStatusFilter,
  resolveStatusIds,
} from "../src/cli/export.ts";
import { ConfigError } from "../src/config.ts";

const statuses = [
  { id: 1, name: "未対応" },
  { id: 2, name: "処理中" },
  { id: 3, name: "処理済み" },
  { id: 4, name: "完了" },
  { id: 5, name: "レビュー待ち" }, // 独自ステータス
  { id: 6, name: "リリース済み" }, // 独自ステータス（完了相当）
];

Deno.test("指定なしなら全ステータスを対象にする", () => {
  assertEquals(resolveStatusFilter(statuses, undefined, undefined), undefined);
});

Deno.test("--open-only は完了以外を列挙する（独自ステータスも含む）", () => {
  assertEquals(resolveStatusFilter(statuses, true, undefined), [1, 2, 3, 5, 6]);
});

Deno.test("--open-only は --closed-status で宣言した独自ステータスも除外する", () => {
  assertEquals(
    resolveStatusFilter(statuses, true, undefined, new Set([4, 6])),
    [1, 2, 3, 5],
  );
});

Deno.test("--closed-status / --started-status の名前を ID に解決する", () => {
  assertEquals(resolveStatusIds(statuses, undefined, "--closed-status"), []);
  assertEquals(resolveStatusIds(statuses, "リリース済み", "--closed-status"), [6]);
  assertEquals(resolveStatusIds(statuses, "処理中, レビュー待ち", "--started-status"), [2, 5]);
  const error = assertThrows(
    () => resolveStatusIds(statuses, "存在しない", "--closed-status"),
    ConfigError,
  );
  assertEquals(error.message.includes("--closed-status"), true);
});

Deno.test("--status は名前を ID に解決する", () => {
  assertEquals(resolveStatusFilter(statuses, false, "未対応, 処理中"), [1, 2]);
});

Deno.test("存在しないステータス名は候補を添えて弾く", () => {
  const error = assertThrows(
    () => resolveStatusFilter(statuses, false, "存在しない"),
    ConfigError,
  );
  assertEquals(error.message.includes("未対応"), true);
});

Deno.test("ラベル接頭辞は既定値を持ち、個別に上書きできる", () => {
  assertEquals(resolveLabelPrefixes(undefined), {
    issueType: "type/",
    category: "category/",
    milestone: "milestone/",
  });
  assertEquals(resolveLabelPrefixes(["type=種別:", "milestone="]), {
    issueType: "種別:",
    category: "category/",
    milestone: "",
  });
});

Deno.test("不正な --label-prefix を弾く", () => {
  assertThrows(() => resolveLabelPrefixes(["type"]), ConfigError);
  assertThrows(() => resolveLabelPrefixes(["unknown=x"]), ConfigError);
});

Deno.test("--assignee は email/name のみ受け付ける", () => {
  assertEquals(resolveAssigneeField(undefined), "email");
  assertEquals(resolveAssigneeField("email"), "email");
  assertEquals(resolveAssigneeField("name"), "name");
  assertThrows(() => resolveAssigneeField("mail"), ConfigError);
});
