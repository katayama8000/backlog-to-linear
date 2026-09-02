import { assertEquals, assertThrows } from "@std/assert";
import {
  resolveAssigneeField,
  resolveLabelPrefixes,
  resolveStatusFilter,
} from "../src/cli/export.ts";
import { ConfigError } from "../src/config.ts";

const statuses = [
  { id: 1, name: "未対応" },
  { id: 2, name: "処理中" },
  { id: 3, name: "処理済み" },
  { id: 4, name: "完了" },
  { id: 5, name: "レビュー待ち" }, // カスタムステータス
];

Deno.test("指定なしなら全ステータスを対象にする", () => {
  assertEquals(resolveStatusFilter(statuses, undefined, undefined), undefined);
});

Deno.test("--open-only は完了以外を列挙する（カスタムステータスも含む）", () => {
  assertEquals(resolveStatusFilter(statuses, true, undefined), [1, 2, 3, 5]);
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
