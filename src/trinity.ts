import { requestUrl } from "obsidian";

/**
 * Trinity's study compass (https://search.a.srg.id.au, see trinity-search
 * docs/api.md "Study compass"). The plugin sends the matrix; Trinity maps every
 * past-paper question onto it, estimates how well each condition is known from
 * the answers, and ranks what to do next by exam marks gained per minute.
 */

export interface MatrixCondition {
  path: string;
  title: string;
  discipline: string;
  topic: string;
  subtopic: string;
  matrixRank: number | null;
  examRank: number | null;
  examYield: number;
  examSittings: number | null;
  status: string;
  completedAt: number | null;
  openedAt: number | null;
  passedAt: number | null;
  snoozedUntil: number | null;
}

export interface MatrixPayload {
  vault: string;
  folder: string;
  examDate: string | null;
  conditions: MatrixCondition[];
}

export type Action = "learn" | "drill" | "finish" | "fix" | "check";

export interface ConditionState {
  path: string;
  mastery: number;
  answered: number;
  missed: number;
  action: Action;
  gain: number;
  minutes: number;
}

export interface Miss {
  questionId: string;
  attemptId: number;
  answeredAt: number;
  insight: string | null;
}

export interface Pick {
  path: string;
  title: string;
  discipline: string;
  status: string;
  mastery: number;
  answered: number;
  action: Action;
  minutes: number;
  gain: number;
  reason: string;
  coach: string | null;
  misses: Miss[];
  practice: { questionIds: string[]; total: number; missed: number; unseen: number };
}

export interface Readiness {
  projected: number;
  afterPlan: number;
  beforeExam: number | null;
  disciplines: { discipline: string; projected: number; afterPlan: number }[];
}

export interface Anticipation {
  exam: { date: string | null; daysLeft: number | null } | null;
  readiness: Readiness | null;
  today: { minutesLeft: number; plan: string[]; planMinutes: number } | null;
  brief: { headline: string } | null;
  next: Pick[];
}

export const ACTION_LABELS: Record<Action, string> = {
  learn: "Learn",
  drill: "Drill",
  finish: "Finish",
  fix: "Fix",
  check: "Check",
};

export class TrinityClient {
  constructor(private baseUrl: string, private apiKey: string) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await requestUrl({
      url: `${this.baseUrl.replace(/\/+$/, "")}${path}`,
      method,
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      throw: false,
    });
    if (response.status >= 400) {
      const detail = (response.json as { detail?: string } | null)?.detail;
      throw new Error(detail ? `${response.status}: ${detail}` : `HTTP ${response.status}`);
    }
    return response.json as T;
  }

  syncMatrix(payload: MatrixPayload): Promise<{ conditions: number; syncedAt: number }> {
    return this.call("PUT", "/api/learning/matrix", payload);
  }

  async matrixState(): Promise<Map<string, ConditionState>> {
    const state = await this.call<{ conditions: ConditionState[] }>("GET", "/api/learning/matrix");
    return new Map(state.conditions.map((c) => [c.path, c]));
  }

  anticipate(): Promise<Anticipation> {
    return this.call("GET", "/api/learning/anticipate");
  }

  condition(path: string): Promise<Pick> {
    return this.call("GET", `/api/learning/matrix/condition?path=${encodeURIComponent(path)}`);
  }

  /** A practice session of these questions, in the given order. */
  async startSession(questionIds: string[]): Promise<string> {
    const session = await this.call<{ id: string }>("POST", "/api/question-bank/sessions", {
      mode: "practice",
      questionIds,
      limit: questionIds.length,
      shuffle: false,
    });
    return session.id;
  }
}

/** Where a question session opens: the native app or the web app. */
export function sessionUrl(sessionId: string, target: "app" | "web"): string {
  const path = `/question-bank?session=${encodeURIComponent(sessionId)}`;
  return target === "app" ? `trinity://open${path}` : `https://trinity.srg.id.au${path}`;
}

/**
 * How much more (or less) likely a note should be offered, from Trinity's
 * estimate of how well it is known: an average unknown condition (60%) is
 * neutral, a weak one up to three times as likely, a well-known one a third.
 * Recent misses add half again.
 */
export function masteryBoost(state: ConditionState | undefined): number {
  if (!state) {
    return 1;
  }
  const weakness = Math.pow(Math.max(0.05, 1 - state.mastery) / 0.4, 1.5);
  const boost = weakness * (state.action === "fix" ? 1.5 : 1);
  return Math.min(3, Math.max(1 / 3, boost));
}
