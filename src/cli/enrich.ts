import { parseArgs } from "@std/cli/parse-args";
import { dirname, join } from "@std/path";
import { LinearClient } from "../linear/client.ts";
import { parseBacklogKey } from "../transform/description.ts";
import type { RelationsFile } from "../transform/relations.ts";
import { ConfigError } from "../config.ts";
import { info, progress, progressDone, verbose, warn } from "../log.ts";

export const enrichHelp = `b2l enrich --team ENG [options]

  CSV 取り込み後に、Linear 上で親子課題（sub-issue）を張り直す。
  Linear CSV には親を指定する列がないため、この後追い処理で復元する。
  突合は Description の脚注 "Migrated from Backlog PROJ-123" を使う。

  --team ENG               取り込み先の Linear Team キー（必須）
  --relations PATH         export が出したサイドカー（既定: ./out/<PROJ>.relations.json）
  --project PROJ           既定パスを組み立てるためのプロジェクトキー
  --dry-run                何を張るか表示するだけで更新しない
  --overwrite              既に親が設定されている課題も上書きする
  --verbose

  環境変数 LINEAR_API_KEY が必要（Settings → Security & access → Personal API keys）。`;

export async function enrich(argv: string[]): Promise<number> {
  const args = parseArgs(argv, {
    string: ["team", "relations", "project"],
    boolean: ["dry-run", "overwrite", "verbose"],
  });

  if (!args.team) throw new ConfigError("--team ENG を指定してください。");
  const apiKey = Deno.env.get("LINEAR_API_KEY");
  if (!apiKey) {
    throw new ConfigError(
      "LINEAR_API_KEY が未設定です。Linear の Settings → Security & access → " +
        "Personal API keys で発行し、環境変数か .env に設定してください。",
    );
  }

  const relationsPath = args.relations ??
    (args.project ? join("out", `${args.project}.relations.json`) : undefined);
  if (!relationsPath) {
    throw new ConfigError("--relations PATH か --project PROJ を指定してください。");
  }

  const relations = await readRelations(relationsPath);
  if (relations.parents.length === 0) {
    info(`${relationsPath}: 親子関係はありません。`);
    return 0;
  }
  info(`${relationsPath}: ${relations.parents.length} 組の親子関係を復元します`);

  const client = new LinearClient({ apiKey });
  const issues = await client.listTeamIssues(args.team);
  if (issues.length === 0) {
    throw new ConfigError(
      `Team "${args.team}" に課題が見つかりません。Team キーと CSV の取り込みを確認してください。`,
    );
  }
  verbose(`Team ${args.team} の課題: ${issues.length} 件`);

  // 脚注から Backlog 課題キー → Linear 課題の対応表を作る
  const byBacklogKey = new Map<string, typeof issues[number]>();
  const duplicates = new Set<string>();
  for (const issue of issues) {
    const key = parseBacklogKey(issue.description);
    if (!key) continue;
    if (byBacklogKey.has(key)) duplicates.add(key);
    byBacklogKey.set(key, issue);
  }
  info(`Backlog 由来と判別できた課題: ${byBacklogKey.size} 件`);
  for (const key of duplicates) {
    warn(`${key} に対応する Linear 課題が複数あります（重複取り込みの可能性）`);
  }

  let updated = 0;
  let skipped = 0;
  const unresolved: string[] = [];

  for (const [index, pair] of relations.parents.entries()) {
    progress(`親子を設定中… ${index + 1}/${relations.parents.length}`);
    const child = byBacklogKey.get(pair.child);
    const parent = byBacklogKey.get(pair.parent);
    if (!child || !parent) {
      unresolved.push(
        `${pair.child} → ${pair.parent}（${!child ? "子" : "親"}が Linear 上に見つかりません）`,
      );
      continue;
    }
    if (child.parentId && !args.overwrite) {
      skipped++;
      verbose(`${child.identifier} は既に親が設定済みのためスキップ`);
      continue;
    }
    if (child.parentId === parent.id) {
      skipped++;
      continue;
    }
    if (args["dry-run"]) {
      info(`(dry-run) ${child.identifier} の親を ${parent.identifier} に設定`);
      updated++;
      continue;
    }
    const success = await client.setParent(child.id, parent.id);
    if (success) {
      updated++;
      verbose(`${child.identifier} → ${parent.identifier}`);
    } else {
      unresolved.push(`${pair.child} → ${pair.parent}（issueUpdate が失敗）`);
    }
  }
  progressDone();

  info("");
  info(
    `${args["dry-run"] ? "(dry-run) " : ""}設定: ${updated} 件 / スキップ: ${skipped} 件 / ` +
      `未解決: ${unresolved.length} 件`,
  );
  for (const line of unresolved) warn(line);
  if (unresolved.length > 0) {
    info("未解決の多くは、絞り込みで親課題が CSV に含まれていない場合に起きます。");
  }
  return 0;
}

async function readRelations(path: string): Promise<RelationsFile> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    throw new ConfigError(
      `${path} が読めません。先に \`b2l export\` を実行してください` +
        `（${dirname(path)} に CSV と一緒に書き出されます）。`,
    );
  }
  const parsed = JSON.parse(text) as RelationsFile;
  if (!Array.isArray(parsed.parents)) {
    throw new ConfigError(`${path} の形式が不正です。`);
  }
  return parsed;
}
