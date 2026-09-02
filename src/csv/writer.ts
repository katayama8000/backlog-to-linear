/**
 * Linear CSV（`npx @linear/import` の "Linear (CSV)" 形式）の書き出し。
 *
 * ヘッダの並びは Linear のエクスポートと同じにしてある。importer が実際に読むのは
 * Title / Description / Status / Estimate / Priority / Assignee / Labels /
 * Created / Started / Completed / Archived のみで、残りは互換のための空欄。
 *
 * Archived に値が入っている行は importer 側でスキップされるため、常に空にする。
 */
export const LINEAR_CSV_HEADERS = [
  "Id",
  "Team",
  "Title",
  "Description",
  "Status",
  "Estimate",
  "Priority",
  "Project",
  "Creator",
  "Assignee",
  "Labels",
  "Cycle Number",
  "Cycle Name",
  "Cycle Start",
  "Cycle End",
  "Created",
  "Updated",
  "Started",
  "Completed",
  "Canceled",
  "Archived",
] as const;

export type LinearCsvHeader = typeof LINEAR_CSV_HEADERS[number];
export type LinearCsvRow = Partial<Record<LinearCsvHeader, string>>;

/**
 * Linear の importer が剥がす文字（stripLeadingSingleQuote と同じ集合）。
 * ここに一致する先頭文字を持つフィールドは `'` を前置しておくと、
 * 表計算ソフトで開いたときの数式解釈を防ぎつつ Linear 側で元に戻る。
 */
const FORMULA_PREFIX = /^[+\-=@∑√∏<>＜＞≤≥＝≠±÷×]/;

export function escapeField(value: string | undefined): string {
  let s = value ?? "";
  if (FORMULA_PREFIX.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replaceAll('"', '""')}"`;
  return s;
}

export function toCsv(rows: readonly LinearCsvRow[]): string {
  const lines = [LINEAR_CSV_HEADERS.join(",")];
  for (const row of rows) {
    lines.push(LINEAR_CSV_HEADERS.map((h) => escapeField(row[h])).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}
