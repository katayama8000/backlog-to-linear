/** Backlog REST API v2 のレスポンス型（この CLI が使うフィールドのみ） */

export interface BacklogProject {
  id: number;
  projectKey: string;
  name: string;
  /** "markdown" | "backlog" */
  textFormattingRule: string;
}

export interface BacklogNamed {
  id: number;
  name: string;
}

export interface BacklogUser {
  id: number;
  userId: string | null;
  name: string;
  mailAddress: string | null;
}

export interface BacklogAttachment {
  id: number;
  name: string;
  size: number;
}

export interface BacklogIssue {
  id: number;
  projectId: number;
  issueKey: string;
  keyId: number;
  issueType: BacklogNamed | null;
  summary: string;
  description: string | null;
  priority: BacklogNamed | null;
  status: BacklogNamed | null;
  assignee: BacklogUser | null;
  category: BacklogNamed[];
  versions: BacklogNamed[];
  milestone: BacklogNamed[];
  startDate: string | null;
  dueDate: string | null;
  estimatedHours: number | null;
  actualHours: number | null;
  parentIssueId: number | null;
  createdUser: BacklogUser | null;
  created: string;
  updated: string;
  attachments: BacklogAttachment[];
}

export interface BacklogComment {
  id: number;
  content: string | null;
  createdUser: BacklogUser | null;
  created: string;
}

/** Backlog の優先度 ID（高/中/低の3種のみ） */
export const BACKLOG_PRIORITY = { HIGH: 2, MIDDLE: 3, LOW: 4 } as const;

/** Backlog の完了ステータス ID。カスタムステータスは 5 以降が振られる。 */
export const BACKLOG_STATUS_CLOSED = 4;
