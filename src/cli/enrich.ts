import { parseArgs } from "@std/cli/parse-args";
import { dirname, join } from "@std/path";
import { LinearClient } from "../linear/client.ts";
import { parseBacklogKey } from "../transform/description.ts";
import type { RelationsFile } from "../transform/relations.ts";
import { type CommentsFile, formatCommentBody } from "../transform/comments.ts";
import { ConfigError, rejectUnknownFlags } from "../config.ts";
import { info, progress, progressDone, verbose, warn } from "../log.ts";

export const enrichHelp = `b2l enrich --project PROJ --team ENG [options]

  CSV 取り込み後に、Linear CSV では運べない情報を後追いで復元する。
  親子課題（sub-issue）と、任意でコメントを投入する。

  突合は Description の脚注 "Migrated from Backlog [PROJ-123]" を使う。

  --project PROJ           Backlog のプロジェクトキー（必須）
  --team ENG               取り込み先の Linear Team キー（必須）
  --comments               コメントも投入する（export の --comments-sidecar が必要）
  --no-parents             親子課題の復元を行わない
  --relations PATH         親子のサイドカー（既定: ./out/sidecars/<PROJ>.relations.json）
  --comments-file PATH     コメントのサイドカー（既定: ./out/sidecars/<PROJ>.comments.json）
  --dry-run                何を張るか表示するだけで更新しない
  --overwrite              既に親が設定されている課題も上書きする
  --verbose

  環境変数 LINEAR_API_KEY が必要（Settings → Security & access → Personal API keys）。`;

export async function enrich(argv: string[]): Promise<number> {
  const args = parseArgs(argv, {
    string: ["team", "relations", "project", "comments-file"],
    boolean: ["dry-run", "overwrite", "verbose", "comments", "parents"],
    default: { parents: true },
    unknown: rejectUnknownFlags([
      "team",
      "relations",
      "project",
      "comments-file",
      "dry-run",
      "overwrite",
      "verbose",
      "comments",
      "parents",
    ]),
  });

  if (!args.project) throw new ConfigError("--project PROJ を指定してください。");
  const apiKey = Deno.env.get("LINEAR_API_KEY");
  if (!apiKey) {
    throw new ConfigError(
      "LINEAR_API_KEY が未設定です。Linear の Settings → Security & access → " +
        "Personal API keys で発行し、環境変数か .env に設定してください。",
    );
  }

  const relationsPath = args.relations ??
    join("out", "sidecars", `${args.project}.relations.json`);
  const commentsPath = args["comments-file"] ??
    join("out", "sidecars", `${args.project}.comments.json`);

  const relations = args.parents ? await readRelations(relationsPath) : null;
  const comments = args.comments ? await readComments(commentsPath) : null;
  if (!relations?.parents.length && !comments?.issues.length) {
    info("復元するものがありません（親子関係もコメントもサイドカーにありません）。");
    return 0;
  }
  if (relations?.parents.length) {
    info(`${relationsPath}: ${relations.parents.length} 組の親子関係`);
  }
  if (comments?.issues.length) {
    const total = comments.issues.reduce((n, i) => n + i.comments.length, 0);
    info(`${commentsPath}: ${total} 件のコメント（${comments.issues.length} 課題）`);
  }

  const client = new LinearClient({ apiKey });
  if (!args.team) {
    const teams = await client.listTeamKeys();
    throw new ConfigError(
      "--team を指定してください（取り込み先に選んだ Team）。この Workspace の Team: " +
        teams.map((t) => `${t.key} (${t.name})`).join(", "),
    );
  }

  // 脚注のマーカーで検索する手もあるが、その検索は書き込みに遅れて追従するため、
  // 取り込み直後だと課題が丸ごと漏れる。Team 指定の一覧は実体を直接読むので確実。
  const issues = await client.listTeamIssues(args.team);
  if (issues.length === 0) {
    const teams = await client.listTeamKeys();
    throw new ConfigError(
      `Team "${args.team}" に課題が見つかりません。この Workspace の Team: ` +
        teams.map((t) => `${t.key} (${t.name})`).join(", "),
    );
  }
  info(`対象 Team: ${issues[0].teamKey} (${issues[0].teamName})`);
  verbose(`Team の課題: ${issues.length} 件`);

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

  const parentPairs = relations?.parents ?? [];
  for (const [index, pair] of parentPairs.entries()) {
    progress(`親子を設定中… ${index + 1}/${parentPairs.length}`);
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
  if (relations?.parents.length) {
    info(
      `${args["dry-run"] ? "(dry-run) " : ""}親子: 設定 ${updated} 件 / スキップ ${skipped} 件`,
    );
  }

  if (comments) {
    const result = await importComments(client, comments, byBacklogKey, {
      dryRun: !!args["dry-run"],
    });
    unresolved.push(...result.unresolved);
    info(
      `${args["dry-run"] ? "(dry-run) " : ""}コメント: 投入 ${result.created} 件 / ` +
        `投入済みでスキップ ${result.skipped} 件`,
    );
  }

  info("");
  info(`未解決: ${unresolved.length} 件`);
  for (const line of unresolved) warn(line);
  if (unresolved.length > 0) {
    info("未解決の多くは、絞り込みで親課題が CSV に含まれていない場合に起きます。");
  }
  return 0;
}

interface CommentImportResult {
  created: number;
  skipped: number;
  unresolved: string[];
}

/**
 * コメントを本物の Linear コメントとして投入する。
 *
 * 投入済み判定は「同じ課題に同じ作成日時のコメントが既にあるか」で行う。
 * commentCreate に渡した createdAt はそのまま保存されるので、本文にマーカーを
 * 埋めなくても再実行を安全にできる。
 */
async function importComments(
  client: LinearClient,
  comments: CommentsFile,
  byBacklogKey: ReadonlyMap<string, { id: string; identifier: string }>,
  opts: { dryRun: boolean },
): Promise<CommentImportResult> {
  let created = 0;
  let skipped = 0;
  const unresolved: string[] = [];

  for (const [index, entry] of comments.issues.entries()) {
    progress(`コメントを投入中… ${index + 1}/${comments.issues.length} 課題`);
    const issue = byBacklogKey.get(entry.key);
    if (!issue) {
      unresolved.push(
        `${entry.key} のコメント ${entry.comments.length} 件（課題が見つかりません）`,
      );
      continue;
    }

    const existing = new Set(
      (await client.listCommentTimestamps(issue.id)).map(normalizeTimestamp),
    );
    // 古い順に入れる
    for (const comment of [...entry.comments].sort((a, b) => a.created.localeCompare(b.created))) {
      const createdAt = new Date(comment.created).toISOString();
      if (existing.has(normalizeTimestamp(createdAt))) {
        skipped++;
        continue;
      }
      if (opts.dryRun) {
        created++;
        verbose(`(dry-run) ${issue.identifier} ← ${comment.author} (${comment.created})`);
        continue;
      }
      const ok = await client.createComment(issue.id, formatCommentBody(comment), createdAt);
      if (ok) {
        created++;
        existing.add(normalizeTimestamp(createdAt));
        verbose(`${issue.identifier} ← ${comment.author} (${comment.created})`);
      } else {
        unresolved.push(`${entry.key} のコメント ${comment.id}（commentCreate が失敗）`);
      }
    }
  }
  progressDone();
  return { created, skipped, unresolved };
}

/** ミリ秒以下の表現ゆれを吸収する（秒単位で比較する） */
function normalizeTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : String(Math.floor(date.getTime() / 1000));
}

async function readComments(path: string): Promise<CommentsFile> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    throw new ConfigError(
      `${path} が読めません。\`b2l export --comments-sidecar\` で書き出してください。`,
    );
  }
  const parsed = JSON.parse(text) as CommentsFile;
  if (!Array.isArray(parsed.issues)) throw new ConfigError(`${path} の形式が不正です。`);
  return parsed;
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
