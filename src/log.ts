let verboseEnabled = false;

export function setVerbose(value: boolean): void {
  verboseEnabled = value;
}

export function info(message: string): void {
  console.log(message);
}

export function warn(message: string): void {
  console.error(`warn: ${message}`);
}

export function verbose(message: string): void {
  if (verboseEnabled) console.error(`  ${message}`);
}

/** 同一行を書き換える進捗表示。パイプに流しているときは何も出さない。 */
export function progress(message: string): void {
  if (!Deno.stderr.isTerminal()) return;
  const text = `\r\x1b[2K${message}`;
  Deno.stderr.writeSync(new TextEncoder().encode(text));
}

export function progressDone(): void {
  if (!Deno.stderr.isTerminal()) return;
  Deno.stderr.writeSync(new TextEncoder().encode("\r\x1b[2K"));
}

/** 並列度を制限して順序を保ったまま map する */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
