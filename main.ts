import { BacklogApiError } from "./src/backlog/client.ts";
import { ConfigError, loadDotEnv } from "./src/config.ts";
import { doctor, doctorHelp } from "./src/cli/doctor.ts";
import { enrich, enrichHelp } from "./src/cli/enrich.ts";
import { exportCommand, exportHelp } from "./src/cli/export.ts";
import { inspect, inspectHelp } from "./src/cli/inspect.ts";
import { setVerbose } from "./src/log.ts";

const HELP = `b2l — Backlog の課題を Linear CSV 形式で書き出す

使い方:
  b2l inspect --project PROJ    プロジェクトの構成を一覧する（下準備）
  b2l export  --project PROJ    課題を Linear CSV として書き出す
  b2l enrich  --team ENG        取り込み後に親子課題を張り直す
  b2l doctor  --project PROJ    API の疎通と権限を確認する

環境変数:
  BACKLOG_SPACE     例: xxx.backlog.jp（--space でも指定可）
  BACKLOG_API_KEY   Backlog の API キー（読み取りのみ使用）
  LINEAR_API_KEY    Linear の Personal API キー（enrich でのみ使用）

取り込みは Linear 公式の \`npx @linear/import\` の "Linear (CSV)" を使います。

各コマンドの詳細:
${[inspectHelp, exportHelp, enrichHelp, doctorHelp].map((h) => `\n${h}`).join("\n")}`;

export async function run(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(HELP);
    return 0;
  }
  if (command === "--version" || command === "version") {
    console.log("0.1.0");
    return 0;
  }

  setVerbose(rest.includes("--verbose"));
  await loadDotEnv();

  switch (command) {
    case "inspect":
      return await inspect(rest);
    case "export":
      return await exportCommand(rest);
    case "enrich":
      return await enrich(rest);
    case "doctor":
      return await doctor(rest);
    default:
      console.error(`不明なコマンド: ${command}\n`);
      console.log(HELP);
      return 2;
  }
}

if (import.meta.main) {
  try {
    Deno.exit(await run(Deno.args));
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`error: ${error.message}`);
      Deno.exit(2);
    }
    if (error instanceof BacklogApiError) {
      console.error(`error: ${error.message}`);
      Deno.exit(1);
    }
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    Deno.exit(1);
  }
}
