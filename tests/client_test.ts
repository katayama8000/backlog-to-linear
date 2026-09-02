import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { BacklogApiError, BacklogClient } from "../src/backlog/client.ts";

interface StubCall {
  url: URL;
}

function stub(
  responses: (Response | (() => Response))[],
): { fetchFn: typeof fetch; calls: StubCall[] } {
  const calls: StubCall[] = [];
  let index = 0;
  const fetchFn = ((input: string | URL | Request) => {
    calls.push({ url: new URL(String(input)) });
    const next = responses[Math.min(index++, responses.length - 1)];
    return Promise.resolve(typeof next === "function" ? next() : next);
  }) as typeof fetch;
  return { fetchFn, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function client(responses: (Response | (() => Response))[]) {
  const { fetchFn, calls } = stub(responses);
  return {
    calls,
    client: new BacklogClient({
      space: "xxx.backlog.jp",
      apiKey: "secret",
      fetchFn,
      sleepFn: () => Promise.resolve(),
    }),
  };
}

Deno.test("apiKey と配列パラメータを付与する", async () => {
  const { client: c, calls } = client([json({ count: 3 })]);
  await c.countIssues({ projectId: 7, statusId: [1, 2] });
  const url = calls[0].url;
  assertEquals(url.origin, "https://xxx.backlog.jp");
  assertEquals(url.pathname, "/api/v2/issues/count");
  assertEquals(url.searchParams.get("apiKey"), "secret");
  assertEquals(url.searchParams.getAll("projectId[]"), ["7"]);
  assertEquals(url.searchParams.getAll("statusId[]"), ["1", "2"]);
});

Deno.test("https:// 付きのスペース指定も受け付ける", () => {
  const c = new BacklogClient({ space: "https://xxx.backlog.com/", apiKey: "k" });
  assertEquals(c.spaceUrl, "https://xxx.backlog.com");
});

Deno.test("課題を 100 件ずつページングし、最後のページで止まる", async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, issueKey: `PROJ-${i + 1}` }));
  const page2 = [{ id: 101, issueKey: "PROJ-101" }];
  const { client: c, calls } = client([json(page1), json(page2)]);

  const issues = [];
  for await (const issue of c.iterIssues({ projectId: 1 })) issues.push(issue);

  assertEquals(issues.length, 101);
  assertEquals(calls.length, 2);
  assertEquals(calls[0].url.searchParams.get("offset"), "0");
  assertEquals(calls[1].url.searchParams.get("offset"), "100");
  assertEquals(calls[0].url.searchParams.get("order"), "asc");
});

Deno.test("429 をリトライして成功する", async () => {
  const { client: c, calls } = client([
    new Response("rate limited", { status: 429, headers: { "retry-after": "0" } }),
    json({ count: 1 }),
  ]);
  assertEquals(await c.countIssues({ projectId: 1 }), 1);
  assertEquals(calls.length, 2);
});

Deno.test("404 はリトライせず即エラーにする", async () => {
  const { client: c, calls } = client([new Response("not found", { status: 404 })]);
  const error = await assertRejects(() => c.getProject("NOPE"), BacklogApiError);
  assertEquals(error.status, 404);
  assertStringIncludes(error.message, "/projects/NOPE");
  assertEquals(calls.length, 1);
});

Deno.test("リトライ上限を超えたら諦める", async () => {
  const { client: c, calls } = client([() => new Response("boom", { status: 503 })]);
  await assertRejects(() => c.countIssues({ projectId: 1 }), BacklogApiError);
  assertEquals(calls.length, 6); // 初回 + maxRetries(5)
});

Deno.test("コメントは minId でページングし、内容が空の履歴を除く", async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({
    id: i + 1,
    content: i === 0 ? null : `c${i + 1}`,
    createdUser: null,
    created: "2024-01-01T00:00:00Z",
  }));
  const page2 = [{ id: 101, content: "  ", createdUser: null, created: "2024-01-01T00:00:00Z" }];
  const { client: c, calls } = client([json(page1), json(page2)]);

  const comments = await c.getComments("PROJ-1");
  assertEquals(comments.length, 99);
  assertEquals(calls[1].url.searchParams.get("minId"), "100");
});
