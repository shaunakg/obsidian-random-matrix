import {
  App,
  FuzzySuggestModal,
  ItemView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
  TFolder,
  WorkspaceLeaf,
  debounce,
  normalizePath,
} from "obsidian";
import {
  Condition,
  DAY_MS,
  PassRecord,
  Plan,
  PlanSettings,
  RANKS,
  Rank,
  Status,
  coverage,
  drawChoices,
  isAvailable,
  makePlan,
  paceForCoverage,
  recentTopics,
  scopedPlan,
  startOfDay,
  weightOf,
  weightedIndex,
} from "./src/engine";
import {
  ACTION_LABELS,
  Anticipation,
  ConditionState,
  MatrixPayload,
  Pick,
  TrinityClient,
  masteryBoost,
  sessionUrl,
} from "./src/trinity";

const VIEW_TYPE = "random-matrix-view";
const FINISHED_STATUSES = ["finished", "done", "complete", "completed", "mastered"];
const IN_PROGRESS_STATUSES = ["in-progress", "doing", "started"];
const PASSED_RETENTION_MS = 30 * DAY_MS;
const EXAM_TIER_FIELD = "exam_rank";
const EXAM_SITTINGS_FIELD = "exam_sittings";
/** Coverage the pace line aims for: past this, extra notes add little. */
const COVERAGE_TARGET = 0.8;
/** How often the compass is refetched while Obsidian is open (answers in Trinity move it). */
const TRINITY_REFRESH_MS = 10 * 60 * 1000;

interface RandomMatrixSettings {
  matrixFolder: string;
  examDate: string;
  dailyTarget: number;
  choiceCount: number;
  rank2Weight: number;
  rank3Weight: number;
  useExamYield: boolean;
  snoozeDays: number;

  rankField: string;
  statusField: string;
  topicField: string;
  subtopicField: string;
  finishedValue: string;
  inProgressValue: string;
  examYieldField: string;

  /** Trinity backend and a personal API key (Trinity → Settings → API keys). */
  trinityUrl: string;
  trinityKey: string;
  openQuestionsIn: "app" | "web";
}

interface RandomMatrixState {
  /** The note being studied right now. */
  current: string | null;
  /** Notes on offer when nothing is current. */
  choices: string[];
  /** Areas (top-level folders) to draw from; empty means all. */
  focus: string[];
  opened: Record<string, number>;
  passed: Record<string, PassRecord>;
  snoozedUntil: Record<string, number>;
  completedAt: Record<string, number>;
}

interface StoredData {
  version: 2;
  settings: RandomMatrixSettings;
  state: RandomMatrixState;
}

/** Shape written by 0.1.x, read once for migration. */
interface LegacyData {
  settings?: {
    targetFolder?: string;
    rankField?: string;
    statusField?: string;
    topicField?: string;
    subtopicField?: string;
    markCompletedValue?: string;
    markInProgressValue?: string;
    snoozeDays?: number;
  };
  data?: {
    lastSeen?: Record<string, number>;
    snoozedUntil?: Record<string, number>;
  };
}

interface RankStats {
  total: number;
  done: number;
}

interface MatrixStats {
  byRank: Record<Rank, RankStats>;
  byArea: Map<string, Record<Rank, RankStats>>;
  /** Share of past exam questions covered by finished notes, if yield is known. */
  coverage: number | null;
  areaCoverage: Map<string, number | null>;
  today: number;
  last7: number;
}

interface AppWithSettings extends App {
  setting?: { open(): void; openTabById(id: string): void };
}

const DEFAULT_SETTINGS: RandomMatrixSettings = {
  matrixFolder: "",
  examDate: "",
  dailyTarget: 3,
  choiceCount: 3,
  rank2Weight: 0.3,
  rank3Weight: 0.1,
  useExamYield: true,
  snoozeDays: 2,

  rankField: "rank",
  statusField: "status",
  topicField: "topic",
  subtopicField: "subtopic",
  finishedValue: "finished",
  inProgressValue: "in-progress",
  examYieldField: "exam_yield",

  trinityUrl: "https://search.a.srg.id.au",
  trinityKey: "",
  openQuestionsIn: "app",
};

function defaultState(): RandomMatrixState {
  return {
    current: null,
    choices: [],
    focus: [],
    opened: {},
    passed: {},
    snoozedUntil: {},
    completedAt: {},
  };
}

export default class RandomMatrixPlugin extends Plugin {
  settings: RandomMatrixSettings = { ...DEFAULT_SETTINGS };
  state: RandomMatrixState = defaultState();
  conditions = new Map<string, Condition>();
  indexed = false;

  private requestSave = debounce(() => void this.persist(), 500, true);
  private requestRender = debounce(() => this.renderViews(), 150, true);
  private requestSync = debounce(() => void this.syncTrinity(), 3000, true);

  /** Trinity's view of the matrix, when connected. */
  trinityState = new Map<string, ConditionState>();
  anticipation: Anticipation | null = null;
  currentPick: Pick | null = null;
  trinityError: string | null = null;
  private lastSync = "";

  async onload() {
    await this.loadPluginData();

    this.registerView(VIEW_TYPE, (leaf) => new RandomMatrixView(leaf, this));
    this.addRibbonIcon("dice", "Random Matrix", () => void this.activateView());
    this.addSettingTab(new RandomMatrixSettingTab(this.app, this));
    this.registerCommands();

    this.app.workspace.onLayoutReady(() => this.rebuildIndex());
    // On a fresh device the cache may still be filling at layout-ready; rebuild once it settles.
    const onResolved = this.app.metadataCache.on("resolved", () => {
      this.app.metadataCache.offref(onResolved);
      this.rebuildIndex();
    });
    this.registerEvent(onResolved);
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => this.onFileChanged(file))
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => this.onFileRenamed(file, oldPath))
    );
    this.registerEvent(this.app.vault.on("delete", (file) => this.onFileDeleted(file)));
    this.registerInterval(window.setInterval(() => void this.refreshTrinity(), TRINITY_REFRESH_MS));
  }

  private registerCommands() {
    this.addCommand({
      id: "random-matrix-pick",
      name: "Pick for me and open",
      callback: () => void this.pickForMe(),
    });

    this.addCommand({
      id: "random-matrix-open-panel",
      name: "Open panel",
      callback: () => void this.activateView(),
    });

    this.addCommand({
      id: "random-matrix-mark-completed",
      name: "Mark this note finished",
      checkCallback: (checking) => {
        const file = this.activeCondition();
        if (file && !checking) {
          void this.markFinished(file);
        }
        return file !== null;
      },
    });

    this.addCommand({
      id: "random-matrix-finish-and-next",
      name: "Mark this note finished and pick the next one",
      checkCallback: (checking) => {
        const file = this.activeCondition();
        if (file && !checking) {
          void this.markFinished(file).then(() => this.pickForMe());
        }
        return file !== null;
      },
    });

    this.addCommand({
      id: "random-matrix-mark-in-progress",
      name: "Mark this note in progress",
      checkCallback: (checking) => {
        const file = this.activeCondition();
        if (file && !checking) {
          void this.setStatus(file, this.settings.inProgressValue);
        }
        return file !== null;
      },
    });

    this.addCommand({
      id: "random-matrix-snooze",
      name: "Snooze this note",
      checkCallback: (checking) => {
        const file = this.activeCondition();
        if (file && !checking) {
          this.snooze(file.path);
        }
        return file !== null;
      },
    });
  }

  onunload() {
    this.requestSave.run();
  }

  // ---------------------------------------------------------------------------
  // Persistence

  async loadPluginData() {
    const stored = (await this.loadData()) as Partial<StoredData> & LegacyData | null;
    if (stored && stored.version === 2) {
      this.settings = { ...DEFAULT_SETTINGS, ...stored.settings };
      this.state = { ...defaultState(), ...stored.state };
      return;
    }
    if (stored) {
      this.migrateLegacy(stored);
      await this.persist();
    }
  }

  private migrateLegacy(legacy: LegacyData) {
    const s = legacy.settings ?? {};
    this.settings = {
      ...DEFAULT_SETTINGS,
      matrixFolder: s.targetFolder ? normalizePath(s.targetFolder) : "",
      rankField: s.rankField || DEFAULT_SETTINGS.rankField,
      statusField: s.statusField || DEFAULT_SETTINGS.statusField,
      topicField: s.topicField || DEFAULT_SETTINGS.topicField,
      subtopicField: s.subtopicField || DEFAULT_SETTINGS.subtopicField,
      finishedValue: s.markCompletedValue || DEFAULT_SETTINGS.finishedValue,
      inProgressValue: s.markInProgressValue || DEFAULT_SETTINGS.inProgressValue,
      snoozeDays: s.snoozeDays ?? DEFAULT_SETTINGS.snoozeDays,
    };
    this.state = {
      ...defaultState(),
      opened: { ...(legacy.data?.lastSeen ?? {}) },
      snoozedUntil: { ...(legacy.data?.snoozedUntil ?? {}) },
    };
  }

  async persist() {
    this.pruneState(Date.now());
    const data: StoredData = { version: 2, settings: this.settings, state: this.state };
    await this.saveData(data);
  }

  /** Save soon, redraw the panel and tell Trinity. */
  changed() {
    this.requestSave();
    this.requestRender();
    if (this.indexed && this.trinity()) {
      this.requestSync();
    }
  }

  private pruneState(now: number) {
    for (const [path, until] of Object.entries(this.state.snoozedUntil)) {
      if (until <= now) {
        delete this.state.snoozedUntil[path];
      }
    }
    for (const [path, record] of Object.entries(this.state.passed)) {
      if (now - record.ts > PASSED_RETENTION_MS) {
        delete this.state.passed[path];
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Index of matrix notes, kept in sync with the metadata cache

  matrixFolder(): string {
    const folder = this.settings.matrixFolder.trim();
    return folder ? normalizePath(folder) : "";
  }

  private inMatrixFolder(path: string): boolean {
    const folder = this.matrixFolder();
    return folder !== "" && path.startsWith(`${folder}/`);
  }

  rebuildIndex() {
    this.conditions.clear();
    if (this.matrixFolder()) {
      for (const file of this.app.vault.getMarkdownFiles()) {
        const condition = this.parseFile(file);
        if (condition) {
          this.conditions.set(file.path, condition);
        }
      }
    }
    this.reconcileCompletions();
    this.indexed = true;
    this.changed();
  }

  /**
   * Make completedAt agree with note statuses. Notes finished while the plugin
   * wasn't watching get their file modification time as a best guess.
   */
  private reconcileCompletions() {
    for (const [path, condition] of this.conditions) {
      const logged = path in this.state.completedAt;
      if (condition.status === "finished" && !logged) {
        const file = this.app.vault.getAbstractFileByPath(path);
        this.state.completedAt[path] = file instanceof TFile ? file.stat.mtime : Date.now();
      } else if (condition.status !== "finished" && logged) {
        delete this.state.completedAt[path];
      }
    }
  }

  private parseFile(file: TFile): Condition | null {
    if (file.extension !== "md" || !this.inMatrixFolder(file.path)) {
      return null;
    }
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm) {
      return null;
    }
    const rank = parseRank(fm[this.settings.rankField]);
    if (rank === null) {
      return null;
    }
    const relative = file.path.slice(this.matrixFolder().length + 1).split("/");
    return {
      path: file.path,
      title: asString(fm.title) || file.basename,
      rank,
      status: this.classifyStatus(fm[this.settings.statusField], fm),
      area: relative.length > 1 ? relative[0] : "",
      topic: asString(fm[this.settings.topicField]),
      subtopic: asString(fm[this.settings.subtopicField]),
      examYield: asNumber(fm[this.settings.examYieldField]),
      examTier: asNumber(fm[EXAM_TIER_FIELD]),
      examSittings: asNumber(fm[EXAM_SITTINGS_FIELD]),
    };
  }

  private classifyStatus(raw: unknown, fm: Record<string, unknown>): Status {
    const status = asString(raw).toLowerCase();
    if (
      status === this.settings.finishedValue.toLowerCase() ||
      FINISHED_STATUSES.includes(status) ||
      fm.completed === true ||
      fm.done === true
    ) {
      return "finished";
    }
    if (
      status === this.settings.inProgressValue.toLowerCase() ||
      IN_PROGRESS_STATUSES.includes(status)
    ) {
      return "in-progress";
    }
    return "not-started";
  }

  private onFileChanged(file: TFile) {
    if (!this.indexed || !this.inMatrixFolder(file.path)) {
      return;
    }
    this.applyCondition(file.path, this.parseFile(file));
  }

  /** Swap in a fresh parse of a note, logging completions as they happen. */
  private applyCondition(path: string, next: Condition | null) {
    const prev = this.conditions.get(path) ?? null;
    if (next) {
      this.conditions.set(path, next);
    } else {
      this.conditions.delete(path);
    }

    const wasFinished = prev?.status === "finished";
    const isFinished = next?.status === "finished";
    if (!wasFinished && isFinished) {
      this.state.completedAt[path] = Date.now();
    } else if (wasFinished && !isFinished) {
      delete this.state.completedAt[path];
    }

    if (!sameCondition(prev, next)) {
      this.changed();
    }
  }

  private onFileRenamed(file: TAbstractFile, oldPath: string) {
    if (!(file instanceof TFile)) {
      // Folder renames fire per-file as well; a renamed matrix folder needs a settings change.
      return;
    }
    const s = this.state;
    for (const map of [s.opened, s.passed, s.snoozedUntil, s.completedAt] as Record<string, unknown>[]) {
      if (oldPath in map) {
        map[file.path] = map[oldPath];
        delete map[oldPath];
      }
    }
    if (s.current === oldPath) {
      s.current = file.path;
    }
    s.choices = s.choices.map((p) => (p === oldPath ? file.path : p));
    this.conditions.delete(oldPath);
    const next = this.parseFile(file);
    if (next) {
      this.conditions.set(file.path, next);
    }
    this.changed();
  }

  private onFileDeleted(file: TAbstractFile) {
    if (this.conditions.has(file.path)) {
      this.conditions.delete(file.path);
      delete this.state.completedAt[file.path];
      this.changed();
    }
  }

  private activeCondition(): TFile | null {
    const file = this.app.workspace.getActiveFile();
    return file && this.conditions.has(file.path) ? file : null;
  }

  // ---------------------------------------------------------------------------
  // Picking

  areas(): string[] {
    const set = new Set<string>();
    for (const c of this.conditions.values()) {
      if (c.area) {
        set.add(c.area);
      }
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  inFocus(c: Condition): boolean {
    return this.state.focus.length === 0 || this.state.focus.includes(c.area);
  }

  planSettings(): PlanSettings {
    return {
      examDate: this.settings.examDate,
      dailyTarget: this.settings.dailyTarget,
      rank2Weight: this.settings.rank2Weight,
      rank3Weight: this.settings.rank3Weight,
      useExamYield: this.settings.useExamYield,
    };
  }

  plan(now = Date.now()): Plan {
    return makePlan([...this.conditions.values()], this.planSettings(), now);
  }

  /** Current note, cleared if it has since been finished, snoozed or removed. */
  currentCondition(): Condition | null {
    const path = this.state.current;
    if (!path) {
      return null;
    }
    const c = this.conditions.get(path);
    const snoozed = (this.state.snoozedUntil[path] ?? 0) > Date.now();
    if (!c || c.status === "finished" || snoozed) {
      this.state.current = null;
      this.changed();
      return null;
    }
    return c;
  }

  /** Choices on offer, topped up to the configured count. */
  choices(): Condition[] {
    const now = Date.now();
    const scoped = [...this.conditions.values()].filter((c) => this.inFocus(c));
    const plan = scopedPlan(this.plan(now), scoped, this.planSettings(), now);
    const kept = this.state.choices
      .map((p) => this.conditions.get(p))
      .filter((c): c is Condition => {
        if (!c || !this.inFocus(c) || c.status === "finished") {
          return false;
        }
        // Drop choices the plan no longer includes (new exam date, new yield data).
        if (plan.priorityOf(c) <= 0) {
          return false;
        }
        return (this.state.snoozedUntil[c.path] ?? 0) <= now;
      });
    const wanted = clampInt(this.settings.choiceCount, 1, 5);
    if (kept.length < wanted) {
      const exclude = new Set(kept.map((c) => c.path));
      kept.push(...this.draw(wanted - kept.length, now, exclude));
    }
    const paths = kept.map((c) => c.path);
    if (paths.join("\n") !== this.state.choices.join("\n")) {
      this.state.choices = paths;
      this.requestSave();
    }
    return kept;
  }

  private draw(count: number, now: number, exclude: Set<string>): Condition[] {
    const all = [...this.conditions.values()];
    const scoped = all.filter((c) => this.inFocus(c));
    const ctx = {
      plan: scopedPlan(this.plan(now), scoped, this.planSettings(), now),
      state: this.state,
      recent: recentTopics(this.state, (p) => this.conditions.get(p)),
      now,
      boost: (c: Condition) => masteryBoost(this.trinityState.get(c.path)),
    };
    let candidates = scoped.filter((c) => isAvailable(c, this.state, now));
    if (candidates.length === 0) {
      // Everything is locked out by recent passes; let them back in rather than show nothing.
      candidates = scoped.filter(
        (c) => c.status !== "finished" && (this.state.snoozedUntil[c.path] ?? 0) <= now
      );
    }
    const loose = { ...ctx, plan: makePlan(scoped, { ...this.planSettings(), examDate: "" }, now) };
    return drawChoices(
      candidates,
      (c) => weightOf(c, ctx),
      count,
      Math.random,
      exclude,
      (c) => weightOf(c, loose)
    );
  }

  /** Pass on everything shown and offer a fresh set. */
  shuffle() {
    const now = Date.now();
    for (const path of this.state.choices) {
      this.markPassed(path, now);
    }
    this.state.choices = [];
    this.changed();
  }

  private markPassed(path: string, now: number) {
    const prev = this.state.passed[path];
    this.state.passed[path] = { ts: now, count: (prev?.count ?? 0) + 1 };
  }

  async choose(path: string) {
    const now = Date.now();
    for (const other of this.state.choices) {
      if (other !== path) {
        this.markPassed(other, now);
      }
    }
    this.state.choices = [];
    this.state.current = path;
    this.state.opened[path] = now;
    this.currentPick = null;
    this.changed();
    await this.openPath(path);
  }

  /** Study a note Trinity suggested, without passing over the choices on offer. */
  async studyThis(path: string) {
    const c = this.conditions.get(path);
    if (c && c.status !== "finished") {
      this.state.current = path;
      this.state.opened[path] = Date.now();
      this.currentPick = null;
      this.changed();
    }
    await this.openPath(path);
  }

  async pickForMe() {
    const current = this.currentCondition();
    if (current) {
      await this.openPath(current.path);
      return;
    }
    if (!this.indexed) {
      new Notice("Random Matrix: still indexing, try again in a moment.");
      return;
    }
    const options = this.choices();
    const index = weightedIndex(options.map(() => 1), Math.random);
    if (index < 0) {
      new Notice(
        this.matrixFolder()
          ? "Random Matrix: nothing left to pick. Nice."
          : "Random Matrix: set your matrix folder in settings first."
      );
      return;
    }
    await this.choose(options[index].path);
  }

  /** Stop studying the current note without finishing it. */
  putBack() {
    if (this.state.current) {
      this.markPassed(this.state.current, Date.now());
      this.state.current = null;
      this.changed();
    }
  }

  snooze(path: string) {
    const days = Math.max(0.1, this.settings.snoozeDays);
    this.state.snoozedUntil[path] = Date.now() + days * DAY_MS;
    if (this.state.current === path) {
      this.state.current = null;
    }
    this.state.choices = this.state.choices.filter((p) => p !== path);
    this.changed();
    new Notice(`Random Matrix: snoozed for ${formatDays(days)}.`);
  }

  async openPath(path: string) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      return;
    }
    const existing = this.app.workspace
      .getLeavesOfType("markdown")
      .find((leaf) => (leaf.view as { file?: TFile }).file?.path === path);
    if (existing) {
      this.app.workspace.setActiveLeaf(existing, { focus: true });
      return;
    }
    await this.app.workspace.getLeaf(false).openFile(file, { active: true });
  }

  async setStatus(file: TFile, value: string) {
    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      fm[this.settings.statusField] = value;
    });
    // Apply immediately rather than waiting for the metadata cache to catch up.
    const prev = this.conditions.get(file.path);
    if (prev) {
      const status = this.classifyStatus(value, {});
      this.applyCondition(file.path, { ...prev, status });
    }
  }

  async markFinished(file: TFile) {
    await this.setStatus(file, this.settings.finishedValue);
    const stats = this.stats();
    const title = this.conditions.get(file.path)?.title ?? file.basename;
    new Notice(`Finished ${title}. ${stats.today} today.`);
  }

  stats(now = Date.now()): MatrixStats {
    const empty = (): Record<Rank, RankStats> => ({
      1: { total: 0, done: 0 },
      2: { total: 0, done: 0 },
      3: { total: 0, done: 0 },
    });
    const byRank = empty();
    const byArea = new Map<string, Record<Rank, RankStats>>();
    for (const c of this.conditions.values()) {
      const area = byArea.get(c.area) ?? empty();
      byArea.set(c.area, area);
      for (const bucket of [byRank[c.rank], area[c.rank]]) {
        bucket.total += 1;
        if (c.status === "finished") {
          bucket.done += 1;
        }
      }
    }
    const todayStart = startOfDay(now);
    const weekStart = todayStart - 6 * DAY_MS;
    let today = 0;
    let last7 = 0;
    for (const ts of Object.values(this.state.completedAt)) {
      if (ts >= todayStart) {
        today += 1;
      }
      if (ts >= weekStart) {
        last7 += 1;
      }
    }
    const all = [...this.conditions.values()];
    const areaCoverage = new Map<string, number | null>();
    for (const area of byArea.keys()) {
      areaCoverage.set(area, coverage(all.filter((c) => c.area === area)));
    }
    return { byRank, byArea, coverage: coverage(all), areaCoverage, today, last7 };
  }

  // ---------------------------------------------------------------------------
  // Trinity

  trinity(): TrinityClient | null {
    const key = this.settings.trinityKey.trim();
    return key ? new TrinityClient(this.settings.trinityUrl.trim() || DEFAULT_SETTINGS.trinityUrl, key) : null;
  }

  private matrixPayload(): MatrixPayload {
    const s = this.state;
    const seconds = (ms: number | undefined) => (ms ? ms / 1000 : null);
    return {
      vault: this.app.vault.getName(),
      folder: this.matrixFolder(),
      examDate: this.settings.examDate || null,
      conditions: [...this.conditions.values()].map((c) => ({
        path: c.path,
        title: c.title,
        discipline: c.area,
        topic: c.topic,
        subtopic: c.subtopic,
        matrixRank: c.rank,
        examRank: c.examTier,
        examYield: c.examYield ?? 0,
        examSittings: c.examSittings,
        status: c.status,
        completedAt: seconds(s.completedAt[c.path]),
        openedAt: seconds(s.opened[c.path]),
        passedAt: seconds(s.passed[c.path]?.ts),
        snoozedUntil: seconds(s.snoozedUntil[c.path]),
      })),
    };
  }

  /** Send the matrix if it changed since the last sync, then refresh the compass. */
  async syncTrinity() {
    const client = this.trinity();
    if (!client || !this.indexed || this.conditions.size === 0) {
      return;
    }
    const payload = this.matrixPayload();
    const signature = JSON.stringify(payload);
    try {
      if (signature !== this.lastSync) {
        await client.syncMatrix(payload);
        this.lastSync = signature;
      }
      await this.refreshTrinity();
    } catch (error) {
      this.trinityFailed(error);
    }
  }

  async refreshTrinity() {
    const client = this.trinity();
    if (!client) {
      return;
    }
    if (!this.lastSync) {
      // Nothing sent yet this session; syncing refreshes afterwards.
      await this.syncTrinity();
      return;
    }
    try {
      const current = this.state.current;
      const [state, anticipation, pick] = await Promise.all([
        client.matrixState(),
        client.anticipate(),
        current ? client.condition(current).catch(() => null) : Promise.resolve(null),
      ]);
      this.trinityState = state;
      this.anticipation = anticipation;
      this.currentPick = pick;
      this.trinityError = null;
      this.requestRender();
    } catch (error) {
      this.trinityFailed(error);
    }
  }

  private trinityFailed(error: unknown) {
    this.trinityError = error instanceof Error ? error.message : String(error);
    this.requestRender();
  }

  /** Start a practice session of a condition's questions and open it in Trinity. */
  async practise(pick: Pick) {
    const client = this.trinity();
    if (!client || pick.practice.questionIds.length === 0) {
      return;
    }
    try {
      const id = await client.startSession(pick.practice.questionIds);
      window.open(sessionUrl(id, this.settings.openQuestionsIn));
    } catch (error) {
      new Notice(`Trinity: couldn't start the questions (${error instanceof Error ? error.message : error}).`);
    }
  }

  // ---------------------------------------------------------------------------
  // Views

  async activateView() {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (!leaf) {
        return;
      }
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  private renderViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof RandomMatrixView) {
        leaf.view.render();
      }
    }
  }

  openSettings() {
    const setting = (this.app as AppWithSettings).setting;
    if (setting) {
      setting.open();
      setting.openTabById(this.manifest.id);
    }
  }
}

class RandomMatrixView extends ItemView {
  plugin: RandomMatrixPlugin;
  /** Consecutive shuffles this session, to nudge towards just picking. */
  private shuffles = 0;

  constructor(leaf: WorkspaceLeaf, plugin: RandomMatrixPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "Random Matrix";
  }

  getIcon() {
    return "dice";
  }

  async onOpen() {
    this.render();
  }

  render() {
    const root = this.contentEl;
    root.empty();
    root.addClass("rmv-root");
    const plugin = this.plugin;

    if (!plugin.matrixFolder()) {
      const empty = root.createDiv({ cls: "rmv-empty" });
      empty.createDiv({ text: "Choose the folder that holds your matrix notes." });
      const button = empty.createEl("button", { text: "Open settings", cls: "mod-cta" });
      button.onclick = () => plugin.openSettings();
      return;
    }
    if (!plugin.indexed) {
      root.createDiv({ text: "Indexing…", cls: "rmv-empty" });
      return;
    }
    if (plugin.conditions.size === 0) {
      root.createDiv({
        text: `No notes with a "${plugin.settings.rankField}" field found in ${plugin.matrixFolder()}.`,
        cls: "rmv-empty",
      });
      return;
    }

    const stats = plugin.stats();
    this.renderFocus(root, stats);
    this.renderTrinity(root);

    const current = plugin.currentCondition();
    if (current) {
      this.renderCurrent(root, current);
    } else {
      this.renderChoices(root);
    }

    this.renderProgress(root, stats);
  }

  private renderFocus(root: HTMLElement, stats: MatrixStats) {
    const areas = this.plugin.areas();
    if (areas.length < 2) {
      return;
    }
    const focus = this.plugin.state.focus;
    const row = root.createDiv({ cls: "rmv-focus" });

    const all = row.createEl("button", { text: "All", cls: "rmv-chip" });
    all.toggleClass("is-active", focus.length === 0);
    all.onclick = () => this.setFocus([]);

    const byYield = this.plugin.plan().byYield;
    for (const area of areas) {
      const r1 = stats.byArea.get(area)?.[1];
      const covered = stats.areaCoverage.get(area) ?? null;
      const chip = row.createEl("button", { cls: "rmv-chip" });
      chip.createSpan({ text: area });
      if (byYield && covered !== null) {
        chip.createSpan({ text: formatPercent(covered), cls: "rmv-chip-count" });
      } else if (r1 && r1.total > 0) {
        chip.createSpan({ text: `${r1.done}/${r1.total}`, cls: "rmv-chip-count" });
      }
      chip.toggleClass("is-active", focus.includes(area));
      chip.setAttr(
        "aria-label",
        (byYield && covered !== null
          ? "Share of this rotation's past exam questions your finished notes cover."
          : "Rank 1 finished/total.") + " Shift-click to combine with other rotations."
      );
      chip.onclick = (event) => {
        if (event.shiftKey || event.metaKey || event.ctrlKey) {
          const next = focus.includes(area)
            ? focus.filter((a) => a !== area)
            : [...focus, area];
          this.setFocus(next);
        } else {
          this.setFocus(focus.length === 1 && focus[0] === area ? [] : [area]);
        }
      };
    }
  }

  private renderTrinity(root: HTMLElement) {
    const plugin = this.plugin;
    if (!plugin.trinity()) {
      return;
    }
    const section = root.createDiv({ cls: "rmv-section rmv-trinity" });
    section.createDiv({ text: "Trinity", cls: "rmv-label" });
    const a = plugin.anticipation;
    if (!a) {
      section.createDiv({
        text: plugin.trinityError ? `Couldn't reach Trinity: ${plugin.trinityError}` : "Syncing…",
        cls: plugin.trinityError ? "rmv-hint rmv-warn" : "rmv-hint",
      });
      return;
    }
    if (a.readiness) {
      const r = a.readiness;
      const row = section.createDiv({ cls: "rmv-bar-row rmv-bar-row-exam" });
      row.createSpan({ text: "Now", cls: "rmv-rank" });
      const bar = row.createDiv({ cls: "rmv-bar" });
      bar.createDiv({ cls: "rmv-bar-fill" }).style.width = `${100 * r.projected}%`;
      row.createSpan({ text: formatPercent(r.projected), cls: "rmv-bar-count" });
      row.setAttr("aria-label", "Expected share of matrix exam marks, from your answers in Trinity and your notes");
      const outlook = [`${formatPercent(r.afterPlan)} after today's plan`];
      if (r.beforeExam !== null) {
        outlook.push(`${formatPercent(r.beforeExam)} by the exam at your daily goal`);
      }
      section.createDiv({ text: outlook.join(" · "), cls: "rmv-hint" });
    }
    if (a.brief) {
      section.createDiv({ text: a.brief.headline, cls: "rmv-brief" });
    }
    for (const pick of a.next.slice(0, 3)) {
      const card = section.createDiv({ cls: "rmv-card rmv-card-choice" });
      const head = card.createDiv({ cls: "rmv-card-head" });
      head.createSpan({ text: ACTION_LABELS[pick.action], cls: `rmv-action rmv-action-${pick.action}` });
      head.createSpan({ text: pick.title, cls: "rmv-card-title" });
      head.createSpan({ text: formatPercent(pick.mastery), cls: "rmv-card-score" }).setAttr(
        "aria-label",
        `Expected to get ${formatPercent(pick.mastery)} of its exam questions right`
      );
      card.createDiv({ text: pick.coach ?? pick.reason, cls: "rmv-card-meta" });
      card.onclick = () => void plugin.studyThis(pick.path);
      this.renderPractise(card, pick);
    }
    if (plugin.trinityError) {
      section.createDiv({ text: `Last refresh failed: ${plugin.trinityError}`, cls: "rmv-hint rmv-warn" });
    }
  }

  private renderPractise(container: HTMLElement, pick: Pick) {
    const count = pick.practice.questionIds.length;
    if (count === 0 || pick.action === "learn" || pick.action === "finish") {
      return;
    }
    const button = container.createEl("button", { text: `Practise ${count} in Trinity`, cls: "rmv-practise" });
    const parts = [`${pick.practice.total} questions on this`];
    if (pick.practice.missed) {
      parts.push(`${pick.practice.missed} missed`);
    }
    parts.push(`${pick.practice.unseen} unseen`);
    button.setAttr("aria-label", parts.join(" · "));
    button.onclick = (event) => {
      event.stopPropagation();
      void this.plugin.practise(pick);
    };
  }

  private setFocus(areas: string[]) {
    this.plugin.state.focus = areas;
    this.plugin.changed();
  }

  private renderCurrent(root: HTMLElement, c: Condition) {
    const section = root.createDiv({ cls: "rmv-section" });
    section.createDiv({ text: "Studying", cls: "rmv-label" });

    const card = section.createDiv({ cls: "rmv-card rmv-card-current" });
    this.renderConditionBody(card, c);
    card.onclick = () => void this.plugin.openPath(c.path);

    const opened = this.plugin.state.opened[c.path];
    if (opened && Date.now() - opened > 12 * 60 * 60 * 1000) {
      section.createDiv({ text: `Started ${formatAgo(opened)}`, cls: "rmv-hint" });
    }

    const pick = this.plugin.currentPick?.path === c.path ? this.plugin.currentPick : null;
    if (pick) {
      const facts = [`${formatPercent(pick.mastery)} expected`];
      if (pick.answered) {
        facts.push(`${pick.answered} answered`);
      }
      if (pick.misses.length) {
        facts.push(`${pick.misses.length} missed lately`);
      }
      section.createDiv({ text: `Trinity: ${facts.join(" · ")}`, cls: "rmv-hint" });
      for (const miss of pick.misses) {
        if (miss.insight) {
          section.createDiv({ text: miss.insight, cls: "rmv-insight" });
        }
      }
      this.renderPractise(section, pick);
    }

    const actions = section.createDiv({ cls: "rmv-actions" });
    const done = actions.createEl("button", { text: "Finished", cls: "mod-cta" });
    done.onclick = async () => {
      const file = this.app.vault.getAbstractFileByPath(c.path);
      if (file instanceof TFile) {
        await this.plugin.markFinished(file);
      }
    };
    const snooze = actions.createEl("button", { text: "Snooze" });
    snooze.setAttr("aria-label", `Hide for ${formatDays(this.plugin.settings.snoozeDays)}`);
    snooze.onclick = () => this.plugin.snooze(c.path);
    const back = actions.createEl("button", { text: "Put back" });
    back.setAttr("aria-label", "Stop for now and choose something else");
    back.onclick = () => this.plugin.putBack();
  }

  private renderChoices(root: HTMLElement) {
    const plugin = this.plugin;
    const choices = plugin.choices();
    const section = root.createDiv({ cls: "rmv-section" });

    if (choices.length === 0) {
      section.createDiv({
        text: plugin.state.focus.length ? "Nothing left in this focus." : "Nothing left to pick.",
        cls: "rmv-empty",
      });
      return;
    }

    section.createDiv({
      text: choices.length > 1 ? "Pick one" : "Up next",
      cls: "rmv-label",
    });
    for (const c of choices) {
      const card = section.createDiv({ cls: "rmv-card rmv-card-choice" });
      this.renderConditionBody(card, c);
      card.onclick = () => {
        this.shuffles = 0;
        void plugin.choose(c.path);
      };
    }

    const actions = section.createDiv({ cls: "rmv-actions" });
    const pick = actions.createEl("button", {
      text: choices.length > 1 ? "Pick for me" : "Start",
    });
    const shuffle = actions.createEl("button", { text: "Shuffle" });
    // After a couple of shuffles, make the decision-free option the obvious one.
    pick.toggleClass("mod-cta", this.shuffles >= 2 || choices.length === 1);
    pick.onclick = () => {
      this.shuffles = 0;
      void plugin.pickForMe();
    };
    shuffle.onclick = () => {
      this.shuffles += 1;
      plugin.shuffle();
    };
    if (this.shuffles >= 2) {
      section.createDiv({
        text: "Any of these is a good use of the next hour.",
        cls: "rmv-hint",
      });
    }
  }

  private renderConditionBody(card: HTMLElement, c: Condition) {
    const head = card.createDiv({ cls: "rmv-card-head" });
    head.createSpan({ text: `R${c.rank}`, cls: `rmv-rank rmv-rank-${c.rank}` });
    head.createSpan({ text: c.title, cls: "rmv-card-title" });
    if (c.examTier !== null && this.plugin.settings.useExamYield) {
      const tier = head.createSpan({
        text: `E${c.examTier}`,
        cls: `rmv-exam rmv-exam-${Math.min(4, Math.max(1, c.examTier))}`,
      });
      tier.setAttr("aria-label", describeExam(c));
    }

    const meta = card.createDiv({ cls: "rmv-card-meta" });
    const crumbs = [c.area, c.topic, c.subtopic].filter((s) => s && s.length > 0);
    meta.createSpan({ text: crumbs.join(" › ") });
    if (c.status === "in-progress") {
      meta.createSpan({ text: "in progress", cls: "rmv-tag" });
    }
    const passes = this.plugin.state.passed[c.path]?.count ?? 0;
    if (passes >= 3) {
      meta.createSpan({ text: `skipped ${passes}×`, cls: "rmv-tag rmv-tag-muted" });
    }
  }

  private renderProgress(root: HTMLElement, stats: MatrixStats) {
    const plugin = this.plugin;
    const plan = plugin.plan();
    const section = root.createDiv({ cls: "rmv-section rmv-progress" });

    if (plan.byYield && stats.coverage !== null) {
      const row = section.createDiv({ cls: "rmv-bar-row rmv-bar-row-exam" });
      row.createSpan({ text: "Exam", cls: "rmv-rank" });
      const bar = row.createDiv({ cls: "rmv-bar" });
      bar.createDiv({ cls: "rmv-bar-fill" }).style.width = `${100 * stats.coverage}%`;
      row.createSpan({ text: formatPercent(stats.coverage), cls: "rmv-bar-count" });
      row.setAttr("aria-label", "Share of past exam questions your finished notes cover");
    }

    for (const rank of RANKS) {
      const s = stats.byRank[rank];
      if (s.total === 0) {
        continue;
      }
      const row = section.createDiv({ cls: `rmv-bar-row rmv-bar-row-${rank}` });
      row.createSpan({ text: `R${rank}`, cls: `rmv-rank rmv-rank-${rank}` });
      const bar = row.createDiv({ cls: "rmv-bar" });
      bar.createDiv({ cls: "rmv-bar-fill" }).style.width = `${(100 * s.done) / s.total}%`;
      row.createSpan({ text: `${s.done}/${s.total}`, cls: "rmv-bar-count" });
    }

    const pace = section.createDiv({ cls: "rmv-pace" });
    pace.createSpan({ text: `${stats.today} today` });
    pace.createSpan({ text: `${(stats.last7 / 7).toFixed(1)}/day this week` });

    const r1Left = plan.remaining[1];
    if (plan.daysLeft !== null) {
      const line = section.createDiv({ cls: "rmv-pace" });
      line.createSpan({ text: `${plan.daysLeft} days to exam` });
      const all = [...plugin.conditions.values()];
      const need = plan.byYield
        ? paceForCoverage(all, COVERAGE_TARGET, plan.daysLeft)
        : r1Left / plan.daysLeft;
      if (need !== null && need > 0) {
        line.createSpan({
          text: plan.byYield
            ? `${need.toFixed(1)}/day reaches ${formatPercent(COVERAGE_TARGET)}`
            : `${need.toFixed(1)}/day finishes rank 1`,
          cls: need > plugin.settings.dailyTarget ? "rmv-warn" : "",
        });
      }
    } else {
      const link = section.createDiv({ cls: "rmv-hint rmv-link" });
      link.setText("Set an exam date to get a plan →");
      link.onclick = () => plugin.openSettings();
    }
    section.createDiv({ text: plan.summary, cls: "rmv-hint" });
  }
}

class RandomMatrixSettingTab extends PluginSettingTab {
  plugin: RandomMatrixPlugin;

  constructor(app: App, plugin: RandomMatrixPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // Not named "update": SettingTab has its own update() that Obsidian calls.
  private saveSetting(apply: () => void, reindex = false) {
    apply();
    if (reindex) {
      this.plugin.rebuildIndex();
    } else {
      this.plugin.changed();
    }
  }

  display(): void {
    const { containerEl } = this;
    const plugin = this.plugin;
    const settings = plugin.settings;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Matrix folder")
      .setDesc("Notes in here with a rank in their frontmatter are the matrix. The first level of subfolders become focus chips.")
      .addText((text) =>
        text
          .setPlaceholder("Year 4C")
          .setValue(settings.matrixFolder)
          .onChange((value) => this.saveSetting(() => (settings.matrixFolder = value.trim()), true))
      )
      .addExtraButton((button) =>
        button
          .setIcon("folder")
          .setTooltip("Browse")
          .onClick(() => {
            new FolderSuggestModal(this.app, (folder) => {
              this.saveSetting(() => (settings.matrixFolder = folder.path), true);
              this.display();
            }).open();
          })
      );

    new Setting(containerEl).setName("Exam plan").setHeading();

    new Setting(containerEl)
      .setName("Exam date")
      .setDesc("With a date set, rank 2 and 3 only come up once rank 1 fits in the days left.")
      .addText((text) => {
        text.inputEl.type = "date";
        text
          .setValue(settings.examDate)
          .onChange((value) => this.saveSetting(() => (settings.examDate = value)));
      });

    new Setting(containerEl)
      .setName("Conditions per day")
      .setDesc("How many you can realistically finish on an average day. Sets how much fits before the exam.")
      .addSlider((slider) =>
        slider
          .setLimits(0.5, 15, 0.5)
          .setDynamicTooltip()
          .setValue(settings.dailyTarget)
          .onChange((value) => this.saveSetting(() => (settings.dailyTarget = value)))
      );

    new Setting(containerEl).setName("Picking").setHeading();

    new Setting(containerEl)
      .setName("Choices offered")
      .setDesc("How many options to show at once. 1 gives a single pick.")
      .addSlider((slider) =>
        slider
          .setLimits(1, 5, 1)
          .setDynamicTooltip()
          .setValue(settings.choiceCount)
          .onChange((value) =>
            this.saveSetting(() => {
              settings.choiceCount = value;
              plugin.state.choices = plugin.state.choices.slice(0, value);
            })
          )
      );

    new Setting(containerEl)
      .setName("Prioritise by exam yield")
      .setDesc(
        `Uses each note's "${settings.examYieldField}" (past-exam questions per 100) plus a small boost for matrix rank. Off, or for notes without it, matrix rank alone decides.`
      )
      .addToggle((toggle) =>
        toggle
          .setValue(settings.useExamYield)
          .onChange((value) => this.saveSetting(() => (settings.useExamYield = value)))
      );

    new Setting(containerEl)
      .setName("Rank 2 weight")
      .setDesc("Without exam yield: how likely a rank 2 note is relative to a rank 1 note.")
      .addSlider((slider) =>
        slider
          .setLimits(0, 1, 0.05)
          .setDynamicTooltip()
          .setValue(settings.rank2Weight)
          .onChange((value) => this.saveSetting(() => (settings.rank2Weight = value)))
      );

    new Setting(containerEl)
      .setName("Rank 3 weight")
      .addSlider((slider) =>
        slider
          .setLimits(0, 1, 0.05)
          .setDynamicTooltip()
          .setValue(settings.rank3Weight)
          .onChange((value) => this.saveSetting(() => (settings.rank3Weight = value)))
      );

    new Setting(containerEl)
      .setName("Snooze length (days)")
      .addSlider((slider) =>
        slider
          .setLimits(1, 14, 1)
          .setDynamicTooltip()
          .setValue(settings.snoozeDays)
          .onChange((value) => this.saveSetting(() => (settings.snoozeDays = value)))
      );

    new Setting(containerEl).setName("Trinity").setHeading();

    new Setting(containerEl)
      .setName("API key")
      .setDesc(
        "A personal key from Trinity (Settings → API keys). The matrix syncs to Trinity, which weights picks by how well your answers say you know each condition, and suggests what to do next."
      )
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("trn_…")
          .setValue(settings.trinityKey)
          .onChange((value) =>
            this.saveSetting(() => {
              settings.trinityKey = value.trim();
              plugin.anticipation = null;
              plugin.trinityState.clear();
            })
          );
      });

    new Setting(containerEl)
      .setName("Server")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.trinityUrl)
          .setValue(settings.trinityUrl)
          .onChange((value) => this.saveSetting(() => (settings.trinityUrl = value.trim() || DEFAULT_SETTINGS.trinityUrl)))
      );

    new Setting(containerEl)
      .setName("Open questions in")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("app", "Trinity app")
          .addOption("web", "Trinity on the web")
          .setValue(settings.openQuestionsIn)
          .onChange((value) => this.saveSetting(() => (settings.openQuestionsIn = value === "web" ? "web" : "app")))
      );

    new Setting(containerEl).setName("Frontmatter").setHeading();

    const field = (name: string, key: "rankField" | "statusField" | "topicField" | "subtopicField" | "finishedValue" | "inProgressValue" | "examYieldField") =>
      new Setting(containerEl).setName(name).addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS[key])
          .setValue(settings[key])
          .onChange((value) =>
            this.saveSetting(() => (settings[key] = value.trim() || DEFAULT_SETTINGS[key]), true)
          )
      );
    field("Rank field", "rankField");
    field("Status field", "statusField");
    field("Topic field", "topicField");
    field("Subtopic field", "subtopicField");
    field("Finished status value", "finishedValue");
    field("In progress status value", "inProgressValue");
    field("Exam yield field", "examYieldField");
  }
}

class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
  constructor(app: App, private onChoose: (folder: TFolder) => void) {
    super(app);
    this.setPlaceholder("Select a folder");
  }

  getItems(): TFolder[] {
    return this.app.vault
      .getAllLoadedFiles()
      .filter((file): file is TFolder => file instanceof TFolder && !file.isRoot());
  }

  getItemText(item: TFolder): string {
    return item.path;
  }

  onChooseItem(item: TFolder): void {
    this.onChoose(item);
  }
}

function parseRank(value: unknown): Rank | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? parseInt(value, 10) : NaN;
  if (!Number.isFinite(n)) {
    return null;
  }
  return Math.max(1, Math.min(3, Math.round(n))) as Rank;
}

function asString(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number") {
    return String(value);
  }
  return "";
}

function sameCondition(a: Condition | null, b: Condition | null): boolean {
  if (!a || !b) {
    return a === b;
  }
  return (
    a.title === b.title &&
    a.rank === b.rank &&
    a.status === b.status &&
    a.area === b.area &&
    a.topic === b.topic &&
    a.subtopic === b.subtopic &&
    a.examYield === b.examYield &&
    a.examTier === b.examTier &&
    a.examSittings === b.examSittings
  );
}

function asNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? parseFloat(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function formatPercent(share: number): string {
  return `${Math.round(100 * share)}%`;
}

function describeExam(c: Condition): string {
  const parts = [`Exam tier ${c.examTier}`];
  if (c.examYield !== null) {
    parts.push(`${c.examYield.toFixed(2)} questions per 100`);
  }
  if (c.examSittings !== null) {
    parts.push(`main topic in ${c.examSittings} of 12 past papers`);
  }
  return parts.join(" · ");
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function formatDays(days: number): string {
  return days === 1 ? "1 day" : `${days} days`;
}

function formatAgo(ts: number): string {
  const days = Math.floor((Date.now() - ts) / DAY_MS);
  if (days < 1) {
    return "today";
  }
  return days === 1 ? "yesterday" : `${days} days ago`;
}
