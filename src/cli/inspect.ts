import { parseArgs } from "@std/cli/parse-args";
import { BacklogClient } from "../backlog/client.ts";
import { BACKLOG_STATUS_CLOSED } from "../backlog/types.ts";
import { ConfigError, resolveCredentials } from "../config.ts";
import { info } from "../log.ts";

export const inspectHelp = `b2l inspect --project PROJ [--space xxx.backlog.jp] [--json]

  移行の下準備用に、プロジェクトのステータス・種別・カテゴリー・マイルストーン・
  参加者と課題数を一覧する。書き込みは一切しない。`;

export async function inspect(argv: string[]): Promise<number> {
  const args = parseArgs(argv, { string: ["space", "project"], boolean: ["json"] });
  if (!args.project) throw new ConfigError("--project PROJ を指定してください。");

  const { space, apiKey } = resolveCredentials(args.space);
  const client = new BacklogClient({ space, apiKey });

  const project = await client.getProject(args.project);
  const [statuses, issueTypes, categories, versions, users] = await Promise.all([
    client.getStatuses(project.projectKey),
    client.getIssueTypes(project.projectKey),
    client.getCategories(project.projectKey),
    client.getVersions(project.projectKey),
    client.getProjectUsers(project.projectKey),
  ]);

  const total = await client.countIssues({ projectId: project.id });
  const open = await client.countIssues({
    projectId: project.id,
    statusId: statuses.map((s) => s.id).filter((id) => id !== BACKLOG_STATUS_CLOSED),
  });

  if (args.json) {
    info(JSON.stringify(
      { project, statuses, issueTypes, categories, versions, users, count: { total, open } },
      null,
      2,
    ));
    return 0;
  }

  info(`プロジェクト: ${project.name} (${project.projectKey})`);
  info(`記法: ${project.textFormattingRule}`);
  info(`課題数: 全 ${total} / 未完了 ${open}`);
  info("");
  info(`ステータス (${statuses.length}) — 小文字化した名前で Linear の状態と突合されます`);
  for (const s of statuses) {
    const mark = s.id === BACKLOG_STATUS_CLOSED
      ? " ← 完了扱い"
      : s.id > BACKLOG_STATUS_CLOSED
      ? " ← 独自ステータス"
      : "";
    info(`  ${s.id}\t${s.name}${mark}`);
  }
  if (statuses.some((s) => s.id > BACKLOG_STATUS_CLOSED)) {
    info(
      "  独自ステータスの種別は Backlog API から判別できません。完了・対応中に相当するものは",
    );
    info(
      "  export で --closed-status / --started-status に名前を渡してください",
    );
  }
  info("");
  info(`課題の種別 (${issueTypes.length}) — ラベル type/… になります`);
  for (const t of issueTypes) info(`  ${t.name}`);
  info("");
  info(`カテゴリー (${categories.length}) — ラベル category/… になります`);
  for (const c of categories) info(`  ${c.name}`);
  info("");
  info(`マイルストーン/バージョン (${versions.length}) — ラベル milestone/… になります`);
  for (const v of versions) info(`  ${v.name}`);
  info("");
  info(`参加者 (${users.length}) — Linear の Workspace に招待しておいてください`);
  for (const u of users) info(`  ${u.name}\t${u.mailAddress ?? "-"}`);
  return 0;
}
