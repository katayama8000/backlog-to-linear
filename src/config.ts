/** 設定はコマンドライン引数と環境変数（+ 任意の .env）から解決する。API キーはファイルに書かない。 */

export interface Credentials {
  space: string;
  apiKey: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** 依存を増やさないための最小の .env ローダ。既存の環境変数は上書きしない。 */
export async function loadDotEnv(path = ".env"): Promise<void> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    const value = rawValue.trim().replace(/^(['"])(.*)\1$/, "$2");
    if (Deno.env.get(key) === undefined) Deno.env.set(key, value);
  }
}

export function resolveCredentials(space: string | undefined): Credentials {
  const resolvedSpace = space ?? Deno.env.get("BACKLOG_SPACE");
  if (!resolvedSpace) {
    throw new ConfigError(
      "Backlog のスペースが未指定です。--space xxx.backlog.jp か BACKLOG_SPACE を設定してください。",
    );
  }
  const apiKey = Deno.env.get("BACKLOG_API_KEY");
  if (!apiKey) {
    throw new ConfigError(
      "BACKLOG_API_KEY が未設定です。環境変数か .env に設定してください。",
    );
  }
  if (!/\.backlog\.(jp|com)$/.test(resolvedSpace.replace(/^https?:\/\//, "").replace(/\/+$/, ""))) {
    throw new ConfigError(
      `スペースの指定が不正です: ${resolvedSpace} （例: xxx.backlog.jp / xxx.backlog.com）`,
    );
  }
  return { space: resolvedSpace, apiKey };
}

/**
 * parseArgs の `unknown` に渡すコールバック。
 *
 * 既定の parseArgs は知らないフラグを黙って受け流すため、綴り違いや
 * 渡す先を間違えたフラグ（`scripts/migrate.sh -- --comments` など）が
 * 「何も起きない」という形で表面化してしまう。ここで即座に落とす。
 */
export function rejectUnknownFlags(allowed: readonly string[]): (arg: string) => boolean {
  const known = new Set(allowed);
  return (arg: string) => {
    if (!arg.startsWith("-")) return true;
    const name = arg.replace(/^--?/, "").replace(/^no-/, "").split("=")[0];
    if (known.has(name)) return true;
    throw new ConfigError(
      `知らないオプションです: ${arg}\n  使えるのは: ${allowed.map((a) => `--${a}`).join(", ")}`,
    );
  };
}
