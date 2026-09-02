import { assertEquals, assertStringIncludes } from "@std/assert";
import { escapeField, LINEAR_CSV_HEADERS, toCsv } from "../src/csv/writer.ts";

Deno.test("ヘッダは Linear のエクスポートと同じ並び", () => {
  assertEquals(LINEAR_CSV_HEADERS[0], "Id");
  assertEquals(LINEAR_CSV_HEADERS[2], "Title");
  assertEquals(LINEAR_CSV_HEADERS[3], "Description");
  assertEquals(LINEAR_CSV_HEADERS.at(-1), "Archived");
  assertEquals(LINEAR_CSV_HEADERS.length, 21);
});

Deno.test("カンマ・引用符・改行を含む値を引用する", () => {
  assertEquals(escapeField("a,b"), '"a,b"');
  assertEquals(escapeField('say "hi"'), '"say ""hi"""');
  assertEquals(escapeField("line1\nline2"), '"line1\nline2"');
  assertEquals(escapeField("plain"), "plain");
  assertEquals(escapeField(undefined), "");
});

Deno.test("数式に見える先頭文字には ' を前置する（Linear 側が剥がす）", () => {
  // Markdown の箇条書きは "-" 始まりなので、この経路は日常的に通る
  assertEquals(escapeField("- item"), "'- item");
  assertEquals(escapeField("=SUM(A1)"), "'=SUM(A1)");
  assertEquals(escapeField("@here"), "'@here");
  assertEquals(escapeField("+1"), "'+1");
  // Linear の stripLeadingSingleQuote と同じ正規表現で元に戻ること
  const stripped = escapeField("- item").replace(/^'([+\-=@∑√∏<>＜＞≤≥＝≠±÷×])/, "$1");
  assertEquals(stripped, "- item");
});

Deno.test("行ごとにヘッダの順で並ぶ", () => {
  const csv = toCsv([{ Title: "t", Description: "d", Status: "未対応" }]);
  const [header, row] = csv.trimEnd().split("\r\n");
  assertEquals(header.split(",")[2], "Title");
  assertEquals(row.split(",")[2], "t");
  assertStringIncludes(csv, "未対応");
  // 指定していない列は空文字で埋まる
  assertEquals(row.split(",").length, LINEAR_CSV_HEADERS.length);
});
