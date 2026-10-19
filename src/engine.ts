// Pure picking logic. No Obsidian imports, so it can be exercised from Node.

export type Rank = 1 | 2 | 3;
export const RANKS: Rank[] = [1, 2, 3];

export type Status = "not-started" | "in-progress" | "finished";

export interface Condition {
  path: string;
  title: string;
  rank: Rank;
  status: Status;
  /** Expected questions per 100 on past exams (exam_yield), if known. */
  examYield: number | null;
  /** Exam tier 1-4 (exam_rank), if known. */
  examTier: number | null;
  /** Past papers it was a main topic in (exam_sittings), if known. */
  examSittings: number | null;
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
  /** Rank by past-exam yield (when notes have it) instead of matrix rank alone. */
  useExamYield: boolean;
}

export interface Plan {
  /** Draw weight before per-note factors; 0 means outside the plan. */
  priorityOf: (c: Condition) => number;
  remaining: Record<Rank, number>;
  daysLeft: number | null;
  capacity: number | null;
  /** Unfinished notes the plan covers; null when everything is in play. */
  planned: number | null;
  /** Whether priorities come from exam yield. */
  byYield: boolean;
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
const MIN_SCOPED_PLAN = 5;

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
 * Matrix rank as a prior on top of exam yield, in the same units (questions per
 * 100). Keeps an unexamined rank 1 ahead of an unexamined rank 3, and roughly
 * matches the median yield of each rank, so neither signal swamps the other.
 */
const MATRIX_PRIOR: Record<Rank, number> = { 1: 0.1, 2: 0.03, 3: 0.01 };

export function hasExamYield(conditions: Iterable<Condition>): boolean {
  for (const c of conditions) {
    if (c.examYield !== null) {
      return true;
    }
  }
  return false;
}

/** How much a note is worth studying, ignoring timing and variety. */
export function basePriority(c: Condition, settings: PlanSettings, byYield: boolean): number {
  if (byYield) {
    return (c.examYield ?? 0) + MATRIX_PRIOR[c.rank];
  }
  const weights: Record<Rank, number> = {
    1: 1,
    2: Math.max(0, settings.rank2Weight),
    3: Math.max(0, settings.rank3Weight),
  };
  return weights[c.rank];
}

/**
 * Decide what's worth drawing. With an exam date, capacity (days left x daily
 * target) goes to the highest-priority unfinished notes; everything below the
 * cut-off is left out. Notes tied at the cut-off share the remaining slots.
 */
export function makePlan(
  conditions: Condition[],
  settings: PlanSettings,
  now: number
): Plan {
  const byYield = settings.useExamYield && hasExamYield(conditions);
  const open = conditions.filter((c) => c.status !== "finished");
  const remaining = countRemaining(open);
  const daysLeft = daysUntil(settings.examDate, now);
  const capacity = daysLeft !== null ? daysLeft * Math.max(0.1, settings.dailyTarget) : null;
  const prio = (c: Condition) => basePriority(c, settings, byYield);

  let cutoff = -Infinity;
  let tieScale = 1;
  let planned: number | null = null;
  if (capacity !== null && capacity < open.length) {
    const sorted = open.map(prio).sort((x, y) => y - x);
    const slots = Math.max(1, Math.floor(capacity));
    cutoff = sorted[slots - 1];
    const above = sorted.filter((p) => p > cutoff).length;
    const tied = sorted.filter((p) => p === cutoff).length;
    tieScale = (slots - above) / tied;
    planned = slots;
  }

  const priorityOf = (c: Condition) => {
    const p = prio(c);
    if (p > cutoff) {
      return p;
    }
    return p === cutoff ? p * tieScale : 0;
  };

  return {
    priorityOf,
    remaining,
    daysLeft,
    capacity,
    planned,
    byYield,
    summary: describePlan(conditions, open, priorityOf, byYield, daysLeft, planned, settings),
  };
}

function describePlan(
  all: Condition[],
  open: Condition[],
  priorityOf: (c: Condition) => number,
  byYield: boolean,
  daysLeft: number | null,
  planned: number | null,
  settings: PlanSettings
): string {
  const pace = `${settings.dailyTarget}/day`;
  if (byYield) {
    if (planned === null) {
      return daysLeft === null
        ? "Weighted by past-exam yield, then matrix rank."
        : `Everything left fits in ${daysLeft}d at ${pace}; highest yield comes up most.`;
    }
    const total = sumYield(all);
    const done = sumYield(all.filter((c) => c.status === "finished"));
    const plan = sumYield(open.filter((c) => priorityOf(c) > 0));
    const reach = total > 0 ? Math.round((100 * (done + plan)) / total) : 0;
    return `Plan: the ${planned} highest-yield notes (${daysLeft}d at ${pace}). Finishing them covers ~${reach}% of past exam questions.`;
  }
  const shares: Record<Rank, number> = { 1: 0, 2: 0, 3: 0 };
  let sum = 0;
  for (const c of open) {
    const w = priorityOf(c);
    shares[c.rank] += w;
    sum += w;
  }
  const mix = RANKS.filter((r) => sum > 0 && shares[r] / sum >= 0.005)
    .map((r) => `R${r} ${Math.round((100 * shares[r]) / sum)}%`)
    .join(" · ");
  if (daysLeft === null) {
    return `Mix: ${mix}`;
  }
  const remaining1 = open.filter((c) => c.rank === 1).length;
  if (planned !== null && remaining1 >= planned) {
    return `Rank 1 only: ${remaining1} left, ~${planned} doable in ${daysLeft}d at ${pace}.`;
  }
  return `Mix: ${mix} (${daysLeft}d at ${pace}).`;
}

export function sumYield(conditions: Iterable<Condition>): number {
  let total = 0;
  for (const c of conditions) {
    total += c.examYield ?? 0;
  }
  return total;
}

/**
 * Share of past exam questions covered by finished notes: the headline
 * progress number when yield data exists.
 */
export function coverage(conditions: Condition[]): number | null {
  const total = sumYield(conditions);
  if (total <= 0) {
    return null;
  }
  return sumYield(conditions.filter((c) => c.status === "finished")) / total;
}

/**
 * Notes per day needed to reach a coverage target by the exam, taking the
 * highest-yield unfinished notes first.
 */
export function paceForCoverage(
  conditions: Condition[],
  target: number,
  daysLeft: number
): number | null {
  const total = sumYield(conditions);
  if (total <= 0 || daysLeft <= 0) {
    return null;
  }
  let covered = sumYield(conditions.filter((c) => c.status === "finished"));
  const open = conditions
    .filter((c) => c.status !== "finished")
    .sort((a, b) => (b.examYield ?? 0) - (a.examYield ?? 0));
  let needed = 0;
  for (const c of open) {
    if (covered / total >= target) {
      break;
    }
    covered += c.examYield ?? 0;
    needed += 1;
  }
  return needed / daysLeft;
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
  plan: Plan;
  state: PickState;
  recent: { topics: Set<string>; subtopics: Set<string> };
  now: number;
}

/** Unnormalised probability of drawing this condition. */
export function weightOf(c: Condition, ctx: WeightContext): number {
  let w = ctx.plan.priorityOf(c);
  if (w <= 0) {
    return 0;
  }

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
 * If the plan leaves (almost) nothing in scope, e.g. the focused rotation has
 * few notes among the top picks, fall back to plain priorities within the
 * scope so there is still a real choice.
 */
export function scopedPlan(
  plan: Plan,
  scope: Condition[],
  settings: PlanSettings,
  now: number
): Plan {
  const inPlan = scope.filter((c) => c.status !== "finished" && plan.priorityOf(c) > 0).length;
  return inPlan >= MIN_SCOPED_PLAN ? plan : makePlan(scope, { ...settings, examDate: "" }, now);
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
  exclude: Set<string> = new Set(),
  fallback?: (c: Condition) => number
): Condition[] {
  const pool = candidates.filter((c) => !exclude.has(c.path));
  const primary = pool.map((c) => weight(c));
  const secondary = fallback ? pool.map((c) => fallback(c)) : null;
  const chosen: Condition[] = [];

  // Fill from the primary weights; once they run dry (e.g. the plan's few
  // remaining notes are all locked out), top up from the fallback weights.
  const adjust = (base: number[]) =>
    pool.map((c, i) => {
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
  while (chosen.length < count) {
    let index = weightedIndex(adjust(primary), rng);
    if (index < 0 && secondary) {
      index = weightedIndex(adjust(secondary), rng);
    }
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
