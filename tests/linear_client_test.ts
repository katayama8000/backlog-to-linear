import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { LinearApiError, LinearClient } from "../src/linear/client.ts";

interface Call {
  query: string;
  variables: Record<string, unknown>;
}

function client(responses: (Response | (() => Response))[]) {
  const calls: Call[] = [];
  let index = 0;
  const fetchFn = ((_input: string | URL | Request, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)) as Call);
    const next = responses[Math.min(index++, responses.length - 1)];
    return Promise.resolve(typeof next === "function" ? next() : next);
  }) as typeof fetch;
  return {
    calls,
    client: new LinearClient({ apiKey: "lin_api_x", fetchFn, sleepFn: () => Promise.resolve() }),
  };
}

function gql(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function issuesPage(
  nodes: { id: string; identifier: string; parent?: { id: string } }[],
  hasNextPage = false,
  endCursor: string | null = null,
) {
  return {
    issues: {
      nodes: nodes.map((n) => ({
        id: n.id,
        identifier: n.identifier,
        description: `Migrated from Backlog [PROJ-${n.identifier.split("-")[1]}](url)`,
        parent: n.parent ?? null,
      })),
      pageInfo: { hasNextPage, endCursor },
    },
  };
}

Deno.test("Team の課題をカーソルで全件取得する", async () => {
  const { client: c, calls } = client([
    gql(issuesPage([{ id: "a", identifier: "ENG-1" }], true, "cursor1")),
    gql(issuesPage([{ id: "b", identifier: "ENG-2", parent: { id: "a" } }])),
  ]);

  const issues = await c.listTeamIssues("ENG");
  assertEquals(issues.length, 2);
  assertEquals(issues[0], {
    id: "a",
    identifier: "ENG-1",
    description: "Migrated from Backlog [PROJ-1](url)",
    parentId: null,
  });
  assertEquals(issues[1].parentId, "a");
  // 1ページ目は after を送らない（JSON では undefined が落ちる）
  assertEquals(calls[0].variables, { key: "ENG" });
  assertEquals(calls[1].variables, { key: "ENG", after: "cursor1" });
});

Deno.test("親を設定する mutation を投げる", async () => {
  const { client: c, calls } = client([gql({ issueUpdate: { success: true } })]);
  assertEquals(await c.setParent("child-id", "parent-id"), true);
  assertStringIncludes(calls[0].query, "issueUpdate");
  assertEquals(calls[0].variables, { id: "child-id", parentId: "parent-id" });
});

Deno.test("GraphQL は 200 でもエラーを返すので中身を見る", async () => {
  const body = JSON.stringify({ errors: [{ message: "Entity not found" }] });
  const { client: c } = client([
    new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
  ]);
  const error = await assertRejects(() => c.setParent("a", "b"), LinearApiError);
  assertStringIncludes(error.message, "Entity not found");
});

Deno.test("401 はリトライしない", async () => {
  const { client: c, calls } = client([new Response("unauthorized", { status: 401 })]);
  const error = await assertRejects(() => c.getViewer(), LinearApiError);
  assertEquals(error.status, 401);
  assertEquals(calls.length, 1);
});

Deno.test("429 はリトライする", async () => {
  const { client: c, calls } = client([
    new Response("slow down", { status: 429, headers: { "retry-after": "0" } }),
    gql({ issueUpdate: { success: true } }),
  ]);
  assertEquals(await c.setParent("a", "b"), true);
  assertEquals(calls.length, 2);
});
