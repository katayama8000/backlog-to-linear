import type { BacklogComment, BacklogIssue } from "../../src/backlog/types.ts";

export function makeIssue(overrides: Partial<BacklogIssue> = {}): BacklogIssue {
  return {
    id: 1001,
    projectId: 1,
    issueKey: "PROJ-1",
    keyId: 1,
    issueType: { id: 1, name: "バグ" },
    summary: "ログインできない",
    description: "手順:\n\n1. ログイン画面を開く\n2. 送信する",
    priority: { id: 3, name: "中" },
    status: { id: 1, name: "未対応" },
    assignee: { id: 10, userId: "yamada", name: "山田太郎", mailAddress: "yamada@example.com" },
    category: [],
    versions: [],
    milestone: [],
    startDate: null,
    dueDate: null,
    estimatedHours: null,
    actualHours: null,
    parentIssueId: null,
    createdUser: { id: 11, userId: "sato", name: "佐藤花子", mailAddress: "sato@example.com" },
    created: "2024-01-01T09:00:00Z",
    updated: "2024-02-01T09:00:00Z",
    attachments: [],
    ...overrides,
  };
}

export function makeComment(overrides: Partial<BacklogComment> = {}): BacklogComment {
  return {
    id: 5001,
    content: "確認しました。",
    createdUser: { id: 10, userId: "yamada", name: "山田太郎", mailAddress: null },
    created: "2024-01-05T09:00:00Z",
    ...overrides,
  };
}
