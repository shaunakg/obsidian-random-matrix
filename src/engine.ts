// Pure picking logic. No Obsidian imports, so it can be exercised from Node.

export type Rank = 1 | 2 | 3;
export const RANKS: Rank[] = [1, 2, 3];

export type Status = "not-started" | "in-progress" | "finished";

export interface Condition {
  path: string;
  title: string;
  rank: Rank;
  status: Status;
  /** First folder under the matrix folder, e.g. "GP" or "Psychiatry". */
  area: string;
  topic: string;
  subtopic: string;
}

export interface PassRecord {
  ts: number;
  count: number;
}

/** Everything the engine needs to know about past behaviour. */
export interface PickState {
  opened: Record<string, number>;
  passed: Record<string, PassRecord>;
  snoozedUntil: Record<string, number>;
}

export interface PlanSettings {
  examDate: string;
  dailyTarget: number;
  rank2Weight: number;
  rank3Weight: number;
}

export interface RankPlan {
  /** Probability of each rank being drawn (before per-note factors). */
  shares: Record<Rank, number>;
  remaining: Record<Rank, number>;
  daysLeft: number | null;
  capacity: number | null;
  summary: string;
}

export type Rng = () => number;

export const DAY_MS = 24 * 60 * 60 * 1000;

const PASS_LOCKOUT_MS = 45 * 60 * 1000;
const PASS_FLOOR = 0.3;
const PASS_HALF_LIFE_DAYS = 1;
const OPEN_LOCKOUT_MS = 6 * 60 * 60 * 1000;
const OPEN_FLOOR = 0.15;
const OPEN_HALF_LIFE_DAYS = 3;
const IN_PROGRESS_WEIGHT = 1.25;
const RECENT_TOPIC_WINDOW = 3;
const RECENT_TOPIC_PENALTY = 0.6;
const RECENT_SUBTOPIC_PENALTY = 0.7;
const SET_AREA_PENALTY = 0.5;
const SET_TOPIC_PENALTY = 0.15;

export function daysUntil(examDate: string, now: number): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(examDate.trim());
  if (!match) {
    return null;
  }
  const exam = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
  const today = startOfDay(now);
  const days = Math.round((exam - today) / DAY_MS);
  return days > 0 ? days : null;
}

export function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function countRemaining(conditions: Iterable<Condition>): Record<Rank, number> {
  const remaining: Record<Rank, number> = { 1: 0, 2: 0, 3: 0 };
  for (const c of conditions) {
    if (c.status !== "finished") {
      remaining[c.rank] += 1;
    }
  }
  return remaining;
}

/**
 * Decide how often each rank should come up. With an exam date, capacity
 * (days left x daily target) is spent on rank 1 first, then rank 2, then
 * rank 3; a rank only gets airtime if there is capacity left for it.
 */
export function planRanks(
  remaining: Record<Rank, number>,
  settings: PlanSettings,
  now: number
): RankPlan {
  const weights: Record<Rank, number> = {
    1: 1,
    2: Math.max(0, settings.rank2Weight),
    3: Math.max(0, settings.rank3Weight),
  };
  const daysLeft = daysUntil(settings.examDate, now);
  const capacity = daysLeft !== null ? daysLeft * Math.max(0.1, settings.dailyTarget) : null;

  let budget: Record<Rank, number> = { ...remaining };
  if (capacity !== null) {
    let left = capacity;
    for (const rank of RANKS) {
      budget[rank] = Math.min(remaining[rank], left);
      left = Math.max(0, left - budget[rank]);
    }
  }

  const raw: Record<Rank, number> = { 1: 0, 2: 0, 3: 0 };
  for (const rank of RANKS) {
    raw[rank] = budget[rank] * weights[rank];
  }
  let total = raw[1] + raw[2] + raw[3];
  if (total <= 0) {
    // Nothing fits the plan (or weights are zero): fall back to whatever is left.
    budget = { ...remaining };
    for (const rank of RANKS) {
      raw[rank] = remaining[rank] * Math.max(weights[rank], 0.01);
    }
    total = raw[1] + raw[2] + raw[3];
  }
  const shares: Record<Rank, number> = { 1: 0, 2: 0, 3: 0 };
  if (total > 0) {
    for (const rank of RANKS) {
      shares[rank] = raw[rank] / total;
    }
  }

  return {
    shares,
    remaining,
    daysLeft,
    capacity,
    summary: describePlan(shares, remaining, daysLeft, capacity, settings.dailyTarget),
  };
}

function describePlan(
  shares: Record<Rank, number>,
  remaining: Record<Rank, number>,
  daysLeft: number | null,
  capacity: number | null,
  dailyTarget: number
): string {
  const mix = RANKS.filter((r) => shares[r] >= 0.005)
    .map((r) => `R${r} ${Math.round(shares[r] * 100)}%`)
    .join(" · ");
  if (daysLeft === null || capacity === null) {
    return `Mix: ${mix}`;
  }
  const cap = Math.round(capacity);
  if (remaining[1] >= capacity) {
    return `Rank 1 only: ${remaining[1]} left, ~${cap} doable in ${daysLeft}d at ${dailyTarget}/day.`;
  }
  return `Mix: ${mix} (~${cap} doable in ${daysLeft}d at ${dailyTarget}/day).`;
}

function decay(elapsedMs: number, floor: number, halfLifeDays: number): number {
  const days = Math.max(0, elapsedMs) / DAY_MS;
  return 1 - (1 - floor) * Math.pow(2, -days / halfLifeDays);
}

export function isAvailable(c: Condition, state: PickState, now: number): boolean {
  if (c.status === "finished") {
    return false;
  }
  const snooze = state.snoozedUntil[c.path];
  if (snooze && snooze > now) {
    return false;
  }
  const passed = state.passed[c.path];
  if (passed && now - passed.ts < PASS_LOCKOUT_MS) {
    return false;
  }
  const opened = state.opened[c.path];
  if (opened && now - opened < OPEN_LOCKOUT_MS) {
    return false;
  }
  return true;
}

/** Topic/subtopic of the last few notes actually opened, for variety. */
export function recentTopics(
  state: PickState,
  lookup: (path: string) => Condition | undefined
): { topics: Set<string>; subtopics: Set<string> } {
  const recent = Object.entries(state.opened)
    .sort((a, b) => b[1] - a[1])
    .slice(0, RECENT_TOPIC_WINDOW)
    .map(([path]) => lookup(path))
    .filter((c): c is Condition => c !== undefined);
  return {
    topics: new Set(recent.map((c) => topicKey(c)).filter((k) => k !== null) as string[]),
    subtopics: new Set(recent.map((c) => subtopicKey(c)).filter((k) => k !== null) as string[]),
  };
}

function topicKey(c: Condition): string | null {
  return c.topic ? `${c.area}/${c.topic}` : null;
}

function subtopicKey(c: Condition): string | null {
  return c.subtopic ? `${c.area}/${c.topic}/${c.subtopic}` : null;
}

export interface WeightContext {
  plan: RankPlan;
  /** Remaining (unfinished) count per rank within the current focus. */
  scopeRemaining: Record<Rank, number>;
  state: PickState;
  recent: { topics: Set<string>; subtopics: Set<string> };
  now: number;
}

/** Unnormalised probability of drawing this condition. */
export function weightOf(c: Condition, ctx: WeightContext): number {
  const scopeCount = ctx.scopeRemaining[c.rank];
  if (scopeCount <= 0) {
    return 0;
  }
  let w = ctx.plan.shares[c.rank] / scopeCount;

  if (c.status === "in-progress") {
    w *= IN_PROGRESS_WEIGHT;
  }

  const opened = ctx.state.opened[c.path];
  if (opened) {
    w *= decay(ctx.now - opened, OPEN_FLOOR, OPEN_HALF_LIFE_DAYS);
  }
  const passed = ctx.state.passed[c.path];
  if (passed) {
    w *= decay(ctx.now - passed.ts, PASS_FLOOR, PASS_HALF_LIFE_DAYS);
  }

  const tk = topicKey(c);
  if (tk && ctx.recent.topics.has(tk)) {
    w *= RECENT_TOPIC_PENALTY;
  }
  const sk = subtopicKey(c);
  if (sk && ctx.recent.subtopics.has(sk)) {
    w *= RECENT_SUBTOPIC_PENALTY;
  }
  return w;
}

/**
 * If the plan gives zero weight to everything in scope (e.g. "rank 1 only"
 * but the focused rotation has no rank 1s left), re-plan within the scope
 * so the user still gets something.
 */
export function effectivePlan(
  plan: RankPlan,
  scopeRemaining: Record<Rank, number>,
  settings: PlanSettings
): RankPlan {
  const covered = RANKS.some((r) => plan.shares[r] > 0 && scopeRemaining[r] > 0);
  if (covered) {
    return plan;
  }
  return planRanks(scopeRemaining, { ...settings, examDate: "" }, 0);
}

/**
 * Draw up to `count` distinct conditions, weighted, nudging the set towards
 * different rotations and topics so the choices feel genuinely different.
 */
export function drawChoices(
  candidates: Condition[],
  weight: (c: Condition) => number,
  count: number,
  rng: Rng,
  exclude: Set<string> = new Set()
): Condition[] {
  const pool = candidates.filter((c) => !exclude.has(c.path));
  const base = pool.map((c) => weight(c));
  const chosen: Condition[] = [];

  while (chosen.length < count) {
    const adjusted = pool.map((c, i) => {
      if (chosen.includes(c)) {
        return 0;
      }
      let w = base[i];
      for (const other of chosen) {
        if (other.area === c.area) {
          w *= SET_AREA_PENALTY;
        }
        const tk = topicKey(c);
        if (tk && tk === topicKey(other)) {
          w *= SET_TOPIC_PENALTY;
        }
      }
      return w;
    });
    const index = weightedIndex(adjusted, rng);
    if (index < 0) {
      break;
    }
    chosen.push(pool[index]);
  }
  return chosen;
}

export function weightedIndex(weights: number[], rng: Rng): number {
  const total = weights.reduce((sum, w) => sum + (w > 0 ? w : 0), 0);
  if (total <= 0) {
    return -1;
  }
  let roll = rng() * total;
  let last = -1;
  for (let i = 0; i < weights.length; i += 1) {
    if (weights[i] <= 0) {
      continue;
    }
    last = i;
    roll -= weights[i];
    if (roll <= 0) {
      return i;
    }
  }
  return last;
}
