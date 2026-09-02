import { parseArgs } from "@std/cli/parse-args";
import { BacklogClient } from "../backlog/client.ts";
import { resolveCredentials } from "../config.ts";
import { info, warn } from "../log.ts";

export const doctorHelp = `b2l doctor --project PROJ [--space xxx.backlog.jp]

  Backlog API の疎通・権限・プロジェクト設定を確認する。`;

export async function doctor(argv: string[]): Promise<number> {
  const args = parseArgs(argv, { string: ["space", "project"] });
  const { space, apiKey } = resolveCredentials(args.space);
  const client = new BacklogClient({ space, apiKey });

  const me = await client.getMyself();
  info(`✓ 接続 OK: ${client.spaceUrl}`);
  info(`✓ 認証 OK: ${me.name} <${me.mailAddress ?? "メールアドレス非公開"}>`);

  if (!args.project) {
    info("プロジェクトを確認するには --project PROJ を付けてください。");
    return 0;
  }

  const project = await client.getProject(args.project);
  info(`✓ プロジェクト: ${project.name} (${project.projectKey}) id=${project.id}`);

  const count = await client.countIssues({ projectId: project.id });
  info(`✓ 課題数: ${count}`);

  if (project.textFormattingRule === "markdown") {
    info("✓ 記法: markdown（そのまま Linear へ持ち込めます）");
    return 0;
  }
  warn(
    `記法が "${project.textFormattingRule}"（Backlog 独自記法）です。` +
      "本文は Markdown として解釈されないため、export は既定で中断します（--force で続行）。",
  );
  return 2;
}
