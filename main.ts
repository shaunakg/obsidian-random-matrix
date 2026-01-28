import {
  App,
  FuzzySuggestModal,
  ItemView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  normalizePath,
} from "obsidian";

const VIEW_TYPE = "random-matrix-view";

interface RandomMatrixSettings {
  targetFolder: string;
  includeSubfolders: boolean;
  excludePathFragments: string[];

  rankField: string;
  statusField: string;
  topicField: string;
  subtopicField: string;

  completedStatuses: string[];
  notStartedStatuses: string[];
  inProgressStatuses: string[];

  markCompletedValue: string;
  markInProgressValue: string;
  markNotStartedValue: string;

  treatMissingStatusAsNotStarted: boolean;
  includeUnranked: boolean;
  unrankedRank: number;

  notStartedWeight: number;
  inProgressWeight: number;
  unknownStatusWeight: number;

  rank2ScatterBase: number;
  rank2ScatterBoost: number;
  rank2ScatterMax: number;
  rank3ScatterBase: number;
  rank3ScatterBoost: number;
  rank3ScatterMax: number;

  excludeRecentCount: number;
  recentPenalty: number;
  historyLimit: number;

  stalenessDays: number;
  maxStalenessBoost: number;

  diversityWindow: number;
  sameTopicPenalty: number;
  sameSubtopicPenalty: number;

  snoozeDays: number;

  autoOpenOnPick: boolean;
  openInNewLeaf: boolean;
  autoMarkInProgressOnOpen: boolean;
  revealInFileExplorer: boolean;

  writeLastReviewed: boolean;
  lastReviewedField: string;
}

interface RandomMatrixData {
  history: SelectionHistoryItem[];
  snoozedUntil: Record<string, number>;
  lastSeen: Record<string, number>;
}

interface SelectionHistoryItem {
  path: string;
  ts: number;
  title: string;
  rank: number | null;
  topic: string;
  subtopic: string;
}

interface NoteMeta {
  file: TFile;
  path: string;
  title: string;
  rank: number | null;
  status: string;
  statusGroup: "not-started" | "in-progress" | "unknown";
  topic: string;
  subtopic: string;
  isCompleted: boolean;
}

interface RankCounts {
  total: number;
  eligible: number;
  completed: number;
}

interface MatrixStats {
  total: number;
  eligible: number;
  completed: number;
  byRank: Record<number, RankCounts>;
  byStatus: Record<string, number>;
}

interface ScanResult {
  notes: NoteMeta[];
  eligible: NoteMeta[];
  rankBuckets: Record<number, NoteMeta[]>;
  stats: MatrixStats;
}

interface PickResult {
  note: NoteMeta;
  stats: MatrixStats;
  reason: string;
}

const DEFAULT_SETTINGS: RandomMatrixSettings = {
  targetFolder: "",
  includeSubfolders: true,
  excludePathFragments: [],

  rankField: "rank",
  statusField: "status",
  topicField: "topic",
  subtopicField: "subtopic",

  completedStatuses: ["completed", "done", "complete", "mastered"],
  notStartedStatuses: ["not-started", "todo", "new"],
  inProgressStatuses: ["in-progress", "doing", "started"],

  markCompletedValue: "completed",
  markInProgressValue: "in-progress",
  markNotStartedValue: "not-started",

  treatMissingStatusAsNotStarted: true,
  includeUnranked: false,
  unrankedRank: 3,

  notStartedWeight: 1,
  inProgressWeight: 0.7,
  unknownStatusWeight: 0.85,

  rank2ScatterBase: 0.15,
  rank2ScatterBoost: 0.35,
  rank2ScatterMax: 0.6,
  rank3ScatterBase: 0.03,
  rank3ScatterBoost: 0.1,
  rank3ScatterMax: 0.2,

  excludeRecentCount: 5,
  recentPenalty: 0.35,
  historyLimit: 200,

  stalenessDays: 14,
  maxStalenessBoost: 1,

  diversityWindow: 3,
  sameTopicPenalty: 0.7,
  sameSubtopicPenalty: 0.8,

  snoozeDays: 1,

  autoOpenOnPick: true,
  openInNewLeaf: false,
  autoMarkInProgressOnOpen: false,
  revealInFileExplorer: false,

  writeLastReviewed: false,
  lastReviewedField: "last-reviewed",
};

const DEFAULT_DATA: RandomMatrixData = {
  history: [],
  snoozedUntil: {},
  lastSeen: {},
};

export default class RandomMatrixPlugin extends Plugin {
  settings: RandomMatrixSettings = DEFAULT_SETTINGS;
  data: RandomMatrixData = DEFAULT_DATA;
  lastPick: PickResult | null = null;

  async onload() {
    await this.loadPluginData();

    this.registerView(VIEW_TYPE, (leaf) => new RandomMatrixView(leaf, this));

    this.addRibbonIcon("dice", "Random Matrix", () => {
      this.activateView();
    });

    this.addCommand({
      id: "random-matrix-pick",
      name: "Random Matrix: Pick next condition",
      callback: async () => {
        const result = await this.pickNext();
        if (!result) {
          return;
        }
        if (this.settings.autoOpenOnPick) {
          await this.openNote(result.note);
        }
        this.refreshView();
      },
    });

    this.addCommand({
      id: "random-matrix-pick-no-open",
      name: "Random Matrix: Pick next condition (no open)",
      callback: async () => {
        await this.pickNext();
        this.refreshView();
      },
    });

    this.addCommand({
      id: "random-matrix-open-panel",
      name: "Random Matrix: Open panel",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "random-matrix-mark-completed",
      name: "Random Matrix: Mark current note completed",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
          return false;
        }
        if (!checking) {
          void this.updateStatus(file, this.settings.markCompletedValue);
        }
        return true;
      },
    });

    this.addCommand({
      id: "random-matrix-mark-in-progress",
      name: "Random Matrix: Mark current note in progress",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
          return false;
        }
        if (!checking) {
          void this.updateStatus(file, this.settings.markInProgressValue);
        }
        return true;
      },
    });

    this.addCommand({
      id: "random-matrix-mark-not-started",
      name: "Random Matrix: Reset current note to not started",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
          return false;
        }
        if (!checking) {
          void this.updateStatus(file, this.settings.markNotStartedValue);
        }
        return true;
      },
    });

    this.addCommand({
      id: "random-matrix-set-target-from-active",
      name: "Random Matrix: Set target folder from current note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !file.parent) {
          return false;
        }
        if (!checking) {
          this.settings.targetFolder = file.parent.path;
          void this.savePluginData();
          this.refreshView();
          new Notice(`Random Matrix: target folder set to ${file.parent.path}`);
        }
        return true;
      },
    });

    this.addSettingTab(new RandomMatrixSettingTab(this.app, this));
  }

  onunload() {
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => leaf.detach());
  }

  async activateView() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (leaves.length === 0) {
      const leaf =
        this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true);
      if (!leaf) {
        return;
      }
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    const activeLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (activeLeaves.length > 0) {
      this.app.workspace.revealLeaf(activeLeaves[0]);
    }
  }

  async loadPluginData() {
    const stored = (await this.loadData()) as
      | { settings?: Partial<RandomMatrixSettings>; data?: Partial<RandomMatrixData> }
      | undefined;
    this.settings = { ...DEFAULT_SETTINGS, ...(stored?.settings ?? {}) };
    this.data = { ...DEFAULT_DATA, ...(stored?.data ?? {}) };
    this.normalizeSettings();
  }

  async savePluginData() {
    await this.saveData({
      settings: this.settings,
      data: this.data,
    });
  }

  normalizeSettings() {
    this.settings.completedStatuses = normalizeList(this.settings.completedStatuses);
    this.settings.notStartedStatuses = normalizeList(this.settings.notStartedStatuses);
    this.settings.inProgressStatuses = normalizeList(this.settings.inProgressStatuses);
    this.settings.excludePathFragments = (this.settings.excludePathFragments || []).filter(
      (value) => value.trim().length > 0
    );
  }

  refreshView() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof RandomMatrixView) {
        void view.refresh();
      }
    }
  }

  async pickNext(): Promise<PickResult | null> {
    const scan = await this.scanNotes();
    if (scan.eligible.length === 0) {
      new Notice("Random Matrix: no eligible notes found.");
      return null;
    }

    const targetRank = this.selectTargetRank(scan);
    const candidates = scan.rankBuckets[targetRank] ?? scan.eligible;
    if (candidates.length === 0) {
      new Notice("Random Matrix: no candidates at target rank.");
      return null;
    }

    const pick = this.weightedPick(candidates);
    if (!pick) {
      new Notice("Random Matrix: could not select a note.");
      return null;
    }

    this.recordPick(pick);

    const reason = `rank ${targetRank} bucket, ${pick.statusGroup}`;

    this.lastPick = { note: pick, stats: scan.stats, reason };
    return this.lastPick;
  }

  async openNote(note: NoteMeta) {
    const leaf = this.settings.openInNewLeaf
      ? this.app.workspace.getLeaf(true)
      : this.app.workspace.getLeaf(false);
    await leaf.openFile(note.file, { active: true });
    if (this.settings.autoMarkInProgressOnOpen) {
      const statusNormalized = normalizeStatus(note.status);
      if (!this.isCompletedStatus(statusNormalized) && note.statusGroup !== "in-progress") {
        await this.updateStatus(note.file, this.settings.markInProgressValue);
      }
    }
    if (this.settings.writeLastReviewed) {
      await this.touchLastReviewed(note.file);
    }
    if (this.settings.revealInFileExplorer) {
      this.revealInFileExplorer(note.file);
    }
  }

  async updateStatus(file: TFile, statusValue: string) {
    const field = this.settings.statusField;
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      frontmatter[field] = statusValue;
      if (this.settings.writeLastReviewed) {
        frontmatter[this.settings.lastReviewedField] = new Date().toISOString();
      }
    });
    new Notice(`Random Matrix: status set to ${statusValue}`);
    this.refreshView();
  }

  async touchLastReviewed(file: TFile) {
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      frontmatter[this.settings.lastReviewedField] = new Date().toISOString();
    });
  }

  async snoozeNote(note: NoteMeta, days: number) {
    const until = Date.now() + days * 24 * 60 * 60 * 1000;
    this.data.snoozedUntil[note.path] = until;
    await this.savePluginData();
    new Notice(`Random Matrix: snoozed for ${days} day(s).`);
  }

  revealInFileExplorer(file: TFile) {
    const leaves = this.app.workspace.getLeavesOfType("file-explorer");
    if (!leaves.length) {
      return;
    }
    const view = leaves[0].view as any;
    if (view?.revealInFolder) {
      view.revealInFolder(file);
    }
  }

  async scanNotes(): Promise<ScanResult> {
    const stats: MatrixStats = {
      total: 0,
      eligible: 0,
      completed: 0,
      byRank: {
        1: { total: 0, eligible: 0, completed: 0 },
        2: { total: 0, eligible: 0, completed: 0 },
        3: { total: 0, eligible: 0, completed: 0 },
      },
      byStatus: {},
    };

    const notes: NoteMeta[] = [];
    const eligible: NoteMeta[] = [];
    const rankBuckets: Record<number, NoteMeta[]> = { 1: [], 2: [], 3: [] };

    const targetFolder = normalizeTargetFolder(this.settings.targetFolder);
    if (!targetFolder) {
      return { notes, eligible, rankBuckets, stats };
    }

    const recentBlocklist = new Set(
      this.data.history.slice(0, Math.max(0, this.settings.excludeRecentCount)).map((h) => h.path)
    );

    const now = Date.now();
    this.purgeExpiredSnoozes(now);

    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!this.isFileInTargetFolder(file, targetFolder)) {
        continue;
      }
      if (this.isExcludedPath(file.path)) {
        continue;
      }

      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
      const rank = this.parseRank(frontmatter[this.settings.rankField]);

      if (rank === null && !this.settings.includeUnranked) {
        continue;
      }

      const statusRaw = frontmatter[this.settings.statusField];
      const status = normalizeStatus(statusRaw);
      const statusGroup = this.getStatusGroup(status, statusRaw);
      const isCompleted = this.isCompleted(status, frontmatter);

      const topic = normalizeString(frontmatter[this.settings.topicField]);
      const subtopic = normalizeString(frontmatter[this.settings.subtopicField]);
      const title = normalizeString(frontmatter["title"]) || file.basename;

      const note: NoteMeta = {
        file,
        path: file.path,
        title,
        rank: rank ?? this.settings.unrankedRank,
        status,
        statusGroup,
        topic,
        subtopic,
        isCompleted,
      };

      notes.push(note);
      stats.total += 1;

      const rankBucket = note.rank ?? this.settings.unrankedRank;
      if (!stats.byRank[rankBucket]) {
        stats.byRank[rankBucket] = { total: 0, eligible: 0, completed: 0 };
      }
      stats.byRank[rankBucket].total += 1;

      if (status) {
        stats.byStatus[status] = (stats.byStatus[status] ?? 0) + 1;
      }

      if (isCompleted) {
        stats.completed += 1;
        stats.byRank[rankBucket].completed += 1;
        continue;
      }

      if (this.data.snoozedUntil[file.path] && this.data.snoozedUntil[file.path] > now) {
        continue;
      }

      if (recentBlocklist.has(file.path)) {
        continue;
      }

      eligible.push(note);
      stats.eligible += 1;
      stats.byRank[rankBucket].eligible += 1;
      rankBuckets[rankBucket].push(note);
    }

    return { notes, eligible, rankBuckets, stats };
  }

  selectTargetRank(scan: ScanResult): number {
    const rank1Total = scan.stats.byRank[1]?.total ?? 0;
    const rank1Remaining = scan.rankBuckets[1]?.length ?? 0;
    const rank2Remaining = scan.rankBuckets[2]?.length ?? 0;
    const rank3Remaining = scan.rankBuckets[3]?.length ?? 0;

    if (rank1Remaining > 0) {
      const completion = rank1Total > 0 ? 1 - rank1Remaining / rank1Total : 1;
      const rank2Chance = clamp(
        this.settings.rank2ScatterBase + this.settings.rank2ScatterBoost * completion,
        0,
        this.settings.rank2ScatterMax
      );
      const rank3Chance = clamp(
        this.settings.rank3ScatterBase + this.settings.rank3ScatterBoost * completion,
        0,
        this.settings.rank3ScatterMax
      );

      const roll = Math.random();
      if (rank2Remaining > 0 && roll < rank2Chance) {
        return 2;
      }
      if (rank3Remaining > 0 && roll < rank2Chance + rank3Chance) {
        return 3;
      }
      return 1;
    }

    if (rank2Remaining > 0) {
      const completion = rank2Remaining > 0 ? 1 - rank2Remaining / (scan.stats.byRank[2]?.total ?? 1) : 1;
      const rank3Chance = clamp(
        this.settings.rank3ScatterBase + this.settings.rank3ScatterBoost * completion,
        0,
        this.settings.rank3ScatterMax
      );
      if (rank3Remaining > 0 && Math.random() < rank3Chance) {
        return 3;
      }
      return 2;
    }

    return 3;
  }

  weightedPick(candidates: NoteMeta[]): NoteMeta | null {
    if (candidates.length === 0) {
      return null;
    }

    const weights = candidates.map((note) => this.scoreNote(note));
    const total = weights.reduce((sum, value) => sum + value, 0);
    if (total <= 0) {
      return candidates[Math.floor(Math.random() * candidates.length)];
    }

    let roll = Math.random() * total;
    for (let i = 0; i < candidates.length; i += 1) {
      roll -= weights[i];
      if (roll <= 0) {
        return candidates[i];
      }
    }

    return candidates[candidates.length - 1];
  }

  scoreNote(note: NoteMeta): number {
    let weight = 1;

    if (note.statusGroup === "not-started") {
      weight *= this.settings.notStartedWeight;
    } else if (note.statusGroup === "in-progress") {
      weight *= this.settings.inProgressWeight;
    } else {
      weight *= this.settings.unknownStatusWeight;
    }

    const historyIndex = this.data.history.findIndex((item) => item.path === note.path);
    if (historyIndex >= 0) {
      weight *= Math.pow(this.settings.recentPenalty, historyIndex + 1);
    }

    const lastSeen = this.data.lastSeen[note.path] ?? 0;
    if (this.settings.stalenessDays > 0) {
      const daysSince = lastSeen > 0 ? (Date.now() - lastSeen) / (24 * 60 * 60 * 1000) : this.settings.stalenessDays * 2;
      const boost = Math.min(this.settings.maxStalenessBoost, daysSince / this.settings.stalenessDays);
      weight *= 1 + boost;
    }

    if (this.settings.diversityWindow > 0 && this.data.history.length > 0) {
      const recent = this.data.history.slice(0, this.settings.diversityWindow);
      if (note.topic && recent.some((item) => item.topic === note.topic)) {
        weight *= this.settings.sameTopicPenalty;
      }
      if (note.subtopic && recent.some((item) => item.subtopic === note.subtopic)) {
        weight *= this.settings.sameSubtopicPenalty;
      }
    }

    return Math.max(0.0001, weight);
  }

  recordPick(note: NoteMeta) {
    const now = Date.now();
    this.data.history.unshift({
      path: note.path,
      ts: now,
      title: note.title,
      rank: note.rank,
      topic: note.topic,
      subtopic: note.subtopic,
    });
    if (this.data.history.length > this.settings.historyLimit) {
      this.data.history.length = this.settings.historyLimit;
    }
    this.data.lastSeen[note.path] = now;
    void this.savePluginData();
  }

  parseRank(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(1, Math.min(3, Math.round(value)));
    }
    if (typeof value === "string") {
      const parsed = parseInt(value, 10);
      if (!Number.isNaN(parsed)) {
        return Math.max(1, Math.min(3, parsed));
      }
    }
    return null;
  }

  getStatusGroup(status: string, raw: unknown): "not-started" | "in-progress" | "unknown" {
    if (!status && raw === undefined && this.settings.treatMissingStatusAsNotStarted) {
      return "not-started";
    }
    if (this.settings.notStartedStatuses.includes(status)) {
      return "not-started";
    }
    if (this.settings.inProgressStatuses.includes(status)) {
      return "in-progress";
    }
    return "unknown";
  }

  isCompleted(status: string, frontmatter: Record<string, unknown>): boolean {
    if (this.isCompletedStatus(status)) {
      return true;
    }
    return frontmatter.completed === true || frontmatter.done === true;
  }

  isCompletedStatus(status: string): boolean {
    return this.settings.completedStatuses.includes(status);
  }

  isExcludedPath(path: string): boolean {
    return this.settings.excludePathFragments.some((fragment) =>
      fragment.length > 0 ? path.includes(fragment) : false
    );
  }

  isFileInTargetFolder(file: TFile, targetFolder: string): boolean {
    if (!targetFolder) {
      return false;
    }
    const targetPrefix = targetFolder.endsWith("/") ? targetFolder : `${targetFolder}/`;
    if (this.settings.includeSubfolders) {
      return file.path.startsWith(targetPrefix) || file.parent?.path === targetFolder;
    }
    return file.parent?.path === targetFolder;
  }

  purgeExpiredSnoozes(now: number) {
    for (const [path, until] of Object.entries(this.data.snoozedUntil)) {
      if (until <= now) {
        delete this.data.snoozedUntil[path];
      }
    }
  }
}

class RandomMatrixView extends ItemView {
  plugin: RandomMatrixPlugin;
  currentPick: PickResult | null = null;

  constructor(leaf: any, plugin: RandomMatrixPlugin) {
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
    await this.refresh();
  }

  async refresh() {
    this.containerEl.empty();
    const root = this.containerEl.createDiv({ cls: "rmv-root" });
    if (!this.currentPick && this.plugin.lastPick) {
      this.currentPick = this.plugin.lastPick;
    }

    const header = root.createDiv({ cls: "rmv-header" });
    header.createEl("div", { text: "Random Matrix", cls: "rmv-title" });

    const targetText = this.plugin.settings.targetFolder
      ? this.plugin.settings.targetFolder
      : "Set a target folder";
    const targetRow = header.createDiv({ cls: "rmv-target-row" });
    targetRow.createEl("span", { text: "Target", cls: "rmv-target-label" });
    targetRow.createEl("span", { text: targetText, cls: "rmv-target" });

    const actionsSection = root.createDiv({ cls: "rmv-section rmv-actions-section" });
    actionsSection.createEl("div", { text: "Actions", cls: "rmv-section-title" });
    const controls = actionsSection.createDiv({ cls: "rmv-actions" });
    const mainRow = controls.createDiv({ cls: "rmv-actions-row" });
    const statusRow = controls.createDiv({ cls: "rmv-actions-row" });
    const utilityRow = controls.createDiv({ cls: "rmv-actions-row" });

    const nextButton = mainRow.createEl("button", { text: "Next", cls: "rmv-btn rmv-btn-primary" });
    nextButton.addEventListener("click", async () => {
      const pick = await this.plugin.pickNext();
      if (!pick) {
        this.currentPick = null;
        await this.renderStats(root);
        return;
      }
      this.currentPick = pick;
      await this.renderPick(root);
      if (this.plugin.settings.autoOpenOnPick) {
        await this.plugin.openNote(pick.note);
      }
    });

    const openButton = mainRow.createEl("button", { text: "Open", cls: "rmv-btn" });
    openButton.addEventListener("click", async () => {
      if (!this.currentPick) {
        return;
      }
      await this.plugin.openNote(this.currentPick.note);
    });

    const doneButton = statusRow.createEl("button", { text: "Done", cls: "rmv-btn" });
    doneButton.addEventListener("click", async () => {
      if (!this.currentPick) {
        return;
      }
      await this.plugin.updateStatus(
        this.currentPick.note.file,
        this.plugin.settings.markCompletedValue
      );
    });

    const progressButton = statusRow.createEl("button", { text: "In Progress", cls: "rmv-btn" });
    progressButton.addEventListener("click", async () => {
      if (!this.currentPick) {
        return;
      }
      await this.plugin.updateStatus(
        this.currentPick.note.file,
        this.plugin.settings.markInProgressValue
      );
    });

    const resetButton = statusRow.createEl("button", { text: "Not Started", cls: "rmv-btn" });
    resetButton.addEventListener("click", async () => {
      if (!this.currentPick) {
        return;
      }
      await this.plugin.updateStatus(
        this.currentPick.note.file,
        this.plugin.settings.markNotStartedValue
      );
    });

    const snoozeButton = utilityRow.createEl("button", { text: "Snooze", cls: "rmv-btn" });
    snoozeButton.addEventListener("click", async () => {
      if (!this.currentPick) {
        return;
      }
      await this.plugin.snoozeNote(this.currentPick.note, this.plugin.settings.snoozeDays);
      const next = await this.plugin.pickNext();
      this.currentPick = next;
      await this.renderPick(root);
    });

    const copyButton = utilityRow.createEl("button", { text: "Copy link", cls: "rmv-btn" });
    copyButton.addEventListener("click", async () => {
      if (!this.currentPick) {
        return;
      }
      const link = this.plugin.app.fileManager.generateMarkdownLink(
        this.currentPick.note.file,
        ""
      );
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(link);
        new Notice("Random Matrix: link copied.");
      } else {
        new Notice("Random Matrix: clipboard unavailable.");
      }
    });

    const revealButton = utilityRow.createEl("button", { text: "Reveal", cls: "rmv-btn" });
    revealButton.addEventListener("click", () => {
      if (!this.currentPick) {
        return;
      }
      this.plugin.revealInFileExplorer(this.currentPick.note.file);
    });

    await this.renderPick(root);
    await this.renderStats(root);
  }

  async renderPick(root: HTMLElement) {
    let pickSection = root.querySelector(".rmv-pick-section");
    if (pickSection) {
      pickSection.remove();
    }

    pickSection = root.createDiv({ cls: "rmv-section rmv-pick-section" });
    pickSection.createEl("div", { text: "Current pick", cls: "rmv-section-title" });
    const pickCard = pickSection.createDiv({ cls: "rmv-pick-card" });

    if (!this.currentPick) {
      pickCard.createEl("div", { text: "Pick a condition to start.", cls: "rmv-empty" });
      return;
    }

    const note = this.currentPick.note;
    const header = pickCard.createDiv({ cls: "rmv-pick-header" });
    header.createEl("div", { text: note.title, cls: "rmv-pick-title" });

    const badges = header.createDiv({ cls: "rmv-badges" });
    badges.createEl("span", { text: `Rank ${note.rank ?? "-"}`, cls: "rmv-badge rmv-badge-rank" });
    const statusLabel = note.status || "no status";
    badges.createEl("span", {
      text: statusLabel,
      cls: `rmv-badge rmv-badge-status rmv-status-${note.statusGroup}`,
    });

    const meta = pickCard.createDiv({ cls: "rmv-pick-meta" });
    if (note.topic) {
      meta.createEl("span", { text: note.topic, cls: "rmv-chip" });
    }
    if (note.subtopic) {
      meta.createEl("span", { text: note.subtopic, cls: "rmv-chip" });
    }

    const lastSeen = this.plugin.data.lastSeen[note.path] ?? 0;
    pickCard.createEl("div", {
      text: `Last picked: ${formatRelativeTime(lastSeen)}`,
      cls: "rmv-pick-last",
    });

    pickCard.createEl("div", { text: note.path, cls: "rmv-pick-path" });
    pickCard.createEl("div", { text: this.currentPick.reason, cls: "rmv-pick-reason" });
  }

  async renderStats(root: HTMLElement) {
    let statsSection = root.querySelector(".rmv-stats-section");
    if (statsSection) {
      statsSection.remove();
    }

    const scan = await this.plugin.scanNotes();
    statsSection = root.createDiv({ cls: "rmv-section rmv-stats-section" });
    statsSection.createEl("div", { text: "Progress", cls: "rmv-section-title" });

    const summary = statsSection.createDiv({ cls: "rmv-stats-summary" });
    const remaining = Math.max(0, scan.stats.total - scan.stats.completed);
    summary.createEl("div", { text: `Total: ${scan.stats.total}`, cls: "rmv-stat" });
    summary.createEl("div", { text: `Eligible now: ${scan.stats.eligible}`, cls: "rmv-stat" });
    summary.createEl("div", { text: `Remaining: ${remaining}`, cls: "rmv-stat" });
    summary.createEl("div", { text: `Completed: ${scan.stats.completed}`, cls: "rmv-stat" });

    const completion = scan.stats.total > 0 ? scan.stats.completed / scan.stats.total : 0;
    const progress = statsSection.createDiv({ cls: "rmv-progress" });
    const progressBar = progress.createDiv({ cls: "rmv-progress-bar" });
    const progressFill = progressBar.createDiv({ cls: "rmv-progress-fill" });
    progressFill.style.width = `${Math.round(completion * 100)}%`;
    progress.createEl("div", {
      text: `${Math.round(completion * 100)}% complete`,
      cls: "rmv-progress-label",
    });

    const rankGrid = statsSection.createDiv({ cls: "rmv-stats-grid" });
    [1, 2, 3].forEach((rank) => {
      const info = scan.stats.byRank[rank];
      const cell = rankGrid.createDiv({ cls: "rmv-stats-cell" });
      cell.createEl("div", { text: `Rank ${rank}`, cls: "rmv-stats-rank" });
      cell.createEl("div", { text: `Remaining: ${info?.eligible ?? 0}`, cls: "rmv-stat" });
      cell.createEl("div", { text: `Done: ${info?.completed ?? 0}`, cls: "rmv-stat" });
      const rankPercent =
        info && info.total > 0 ? Math.round((info.completed / info.total) * 100) : 0;
      const rankProgress = cell.createDiv({ cls: "rmv-rank-progress" });
      const rankFill = rankProgress.createDiv({ cls: "rmv-rank-progress-fill" });
      rankFill.style.width = `${rankPercent}%`;
      cell.createEl("div", { text: `${rankPercent}% complete`, cls: "rmv-rank-label" });
    });

    if (scan.stats.byStatus && Object.keys(scan.stats.byStatus).length > 0) {
      const statusRow = statsSection.createDiv({ cls: "rmv-stats-status" });
      Object.entries(scan.stats.byStatus)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .forEach(([status, count]) => {
          statusRow.createEl("span", { text: `${status}: ${count}`, cls: "rmv-chip" });
        });
    }
  }
}

class RandomMatrixSettingTab extends PluginSettingTab {
  plugin: RandomMatrixPlugin;

  constructor(app: App, plugin: RandomMatrixPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Random Matrix" });

    new Setting(containerEl)
      .setName("Target folder")
      .setDesc("Folder to pull conditions from.")
      .addText((text) =>
        text
          .setPlaceholder("Year 4C/GP")
          .setValue(this.plugin.settings.targetFolder)
          .onChange(async (value) => {
            this.plugin.settings.targetFolder = value.trim();
            await this.plugin.savePluginData();
            this.plugin.refreshView();
          })
      )
      .addButton((button) => {
        button.setButtonText("Browse");
        button.onClick(() => {
          const modal = new FolderSuggestModal(this.app, (folder) => {
            this.plugin.settings.targetFolder = folder.path;
            void this.plugin.savePluginData();
            this.plugin.refreshView();
            this.display();
          });
          modal.open();
        });
      })
      .addButton((button) => {
        button.setButtonText("Use current note");
        button.onClick(async () => {
          const file = this.app.workspace.getActiveFile();
          if (!file?.parent) {
            new Notice("Random Matrix: open a note to use its folder.");
            return;
          }
          this.plugin.settings.targetFolder = file.parent.path;
          await this.plugin.savePluginData();
          this.plugin.refreshView();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName("Include subfolders")
      .setDesc("Include notes in subfolders of the target folder.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.includeSubfolders).onChange(async (value) => {
          this.plugin.settings.includeSubfolders = value;
          await this.plugin.savePluginData();
          this.plugin.refreshView();
        })
      );

    new Setting(containerEl)
      .setName("Exclude path fragments")
      .setDesc("One per line. Notes with matching path fragments are ignored.")
      .addTextArea((text) => {
        text
          .setPlaceholder("Resource Directory.md")
          .setValue(this.plugin.settings.excludePathFragments.join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.excludePathFragments = value
              .split(/\n|,/)
              .map((item) => item.trim())
              .filter((item) => item.length > 0);
            await this.plugin.savePluginData();
            this.plugin.refreshView();
          });
      });

    containerEl.createEl("h3", { text: "Frontmatter fields" });

    new Setting(containerEl)
      .setName("Rank field")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.rankField)
          .onChange(async (value) => {
            this.plugin.settings.rankField = value.trim() || "rank";
            await this.plugin.savePluginData();
            this.plugin.refreshView();
          })
      );

    new Setting(containerEl)
      .setName("Status field")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.statusField)
          .onChange(async (value) => {
            this.plugin.settings.statusField = value.trim() || "status";
            await this.plugin.savePluginData();
            this.plugin.refreshView();
          })
      );

    new Setting(containerEl)
      .setName("Topic field")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.topicField)
          .onChange(async (value) => {
            this.plugin.settings.topicField = value.trim() || "topic";
            await this.plugin.savePluginData();
            this.plugin.refreshView();
          })
      );

    new Setting(containerEl)
      .setName("Subtopic field")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.subtopicField)
          .onChange(async (value) => {
            this.plugin.settings.subtopicField = value.trim() || "subtopic";
            await this.plugin.savePluginData();
            this.plugin.refreshView();
          })
      );

    containerEl.createEl("h3", { text: "Status values" });

    new Setting(containerEl)
      .setName("Completed statuses")
      .setDesc("Comma or line separated.")
      .addTextArea((text) =>
        text
          .setValue(this.plugin.settings.completedStatuses.join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.completedStatuses = normalizeList(
              value.split(/\n|,/).map((item) => item.trim())
            );
            await this.plugin.savePluginData();
            this.plugin.refreshView();
          })
      );

    new Setting(containerEl)
      .setName("Not started statuses")
      .setDesc("Used for weighting.")
      .addTextArea((text) =>
        text
          .setValue(this.plugin.settings.notStartedStatuses.join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.notStartedStatuses = normalizeList(
              value.split(/\n|,/).map((item) => item.trim())
            );
            await this.plugin.savePluginData();
            this.plugin.refreshView();
          })
      );

    new Setting(containerEl)
      .setName("In progress statuses")
      .setDesc("Used for weighting.")
      .addTextArea((text) =>
        text
          .setValue(this.plugin.settings.inProgressStatuses.join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.inProgressStatuses = normalizeList(
              value.split(/\n|,/).map((item) => item.trim())
            );
            await this.plugin.savePluginData();
            this.plugin.refreshView();
          })
      );

    new Setting(containerEl)
      .setName("Mark completed value")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.markCompletedValue)
          .onChange(async (value) => {
            this.plugin.settings.markCompletedValue = value.trim() || "completed";
            await this.plugin.savePluginData();
          })
      );

    new Setting(containerEl)
      .setName("Mark in progress value")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.markInProgressValue)
          .onChange(async (value) => {
            this.plugin.settings.markInProgressValue = value.trim() || "in-progress";
            await this.plugin.savePluginData();
          })
      );

    new Setting(containerEl)
      .setName("Mark not started value")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.markNotStartedValue)
          .onChange(async (value) => {
            this.plugin.settings.markNotStartedValue = value.trim() || "not-started";
            await this.plugin.savePluginData();
          })
      );

    new Setting(containerEl)
      .setName("Treat missing status as not started")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.treatMissingStatusAsNotStarted).onChange(async (value) => {
          this.plugin.settings.treatMissingStatusAsNotStarted = value;
          await this.plugin.savePluginData();
          this.plugin.refreshView();
        })
      );

    containerEl.createEl("h3", { text: "Rank behavior" });

    new Setting(containerEl)
      .setName("Include unranked notes")
      .setDesc("If enabled, notes without a rank use the fallback rank.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.includeUnranked).onChange(async (value) => {
          this.plugin.settings.includeUnranked = value;
          await this.plugin.savePluginData();
          this.plugin.refreshView();
        })
      );

    new Setting(containerEl)
      .setName("Fallback rank for unranked")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.unrankedRank))
          .onChange(async (value) => {
            const parsed = parseNumber(value, 3);
            this.plugin.settings.unrankedRank = Math.max(1, Math.min(3, Math.round(parsed)));
            await this.plugin.savePluginData();
            this.plugin.refreshView();
          })
      );

    new Setting(containerEl)
      .setName("Rank 2 scatter base")
      .setDesc("Base chance to pick rank 2 when rank 1 remains.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.rank2ScatterBase))
          .onChange(async (value) => {
            this.plugin.settings.rank2ScatterBase = clamp(parseNumber(value, 0.15), 0, 1);
            await this.plugin.savePluginData();
          })
      );

    new Setting(containerEl)
      .setName("Rank 2 scatter boost")
      .setDesc("Added chance as rank 1 completion increases.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.rank2ScatterBoost))
          .onChange(async (value) => {
            this.plugin.settings.rank2ScatterBoost = clamp(parseNumber(value, 0.35), 0, 1);
            await this.plugin.savePluginData();
          })
      );

    new Setting(containerEl)
      .setName("Rank 2 scatter max")
      .setDesc("Upper limit for rank 2 scatter chance.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.rank2ScatterMax))
          .onChange(async (value) => {
            this.plugin.settings.rank2ScatterMax = clamp(parseNumber(value, 0.6), 0, 1);
            await this.plugin.savePluginData();
          })
      );

    new Setting(containerEl)
      .setName("Rank 3 scatter base")
      .setDesc("Base chance to pick rank 3 when higher ranks remain.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.rank3ScatterBase))
          .onChange(async (value) => {
            this.plugin.settings.rank3ScatterBase = clamp(parseNumber(value, 0.03), 0, 1);
            await this.plugin.savePluginData();
          })
      );

    new Setting(containerEl)
      .setName("Rank 3 scatter boost")
      .setDesc("Added chance as higher ranks complete.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.rank3ScatterBoost))
          .onChange(async (value) => {
            this.plugin.settings.rank3ScatterBoost = clamp(parseNumber(value, 0.1), 0, 1);
            await this.plugin.savePluginData();
          })
      );

    new Setting(containerEl)
      .setName("Rank 3 scatter max")
      .setDesc("Upper limit for rank 3 scatter chance.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.rank3ScatterMax))
          .onChange(async (value) => {
            this.plugin.settings.rank3ScatterMax = clamp(parseNumber(value, 0.2), 0, 1);
            await this.plugin.savePluginData();
          })
      );

    containerEl.createEl("h3", { text: "Heuristic weights" });

    new Setting(containerEl)
      .setName("Not started weight")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.notStartedWeight))
          .onChange(async (value) => {
            this.plugin.settings.notStartedWeight = parseNumber(value, 1);
            await this.plugin.savePluginData();
          })
      );

    new Setting(containerEl)
      .setName("In progress weight")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.inProgressWeight))
          .onChange(async (value) => {
            this.plugin.settings.inProgressWeight = parseNumber(value, 0.7);
            await this.plugin.savePluginData();
          })
      );

    new Setting(containerEl)
      .setName("Unknown status weight")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.unknownStatusWeight))
          .onChange(async (value) => {
            this.plugin.settings.unknownStatusWeight = parseNumber(value, 0.85);
            await this.plugin.savePluginData();
          })
      );

    new Setting(containerEl)
      .setName("Exclude recent picks")
      .setDesc("Number of most recent picks to exclude entirely.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.excludeRecentCount))
          .onChange(async (value) => {
            this.plugin.settings.excludeRecentCount = Math.max(0, Math.floor(parseNumber(value, 5)));
            await this.plugin.savePluginData();
          })
      );

    new Setting(containerEl)
      .setName("Recent penalty")
      .setDesc("Penalty applied for older history items. 1 means no penalty.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.recentPenalty))
          .onChange(async (value) => {
            this.plugin.settings.recentPenalty = clamp(parseNumber(value, 0.35), 0.01, 1);
            await this.plugin.savePluginData();
          })
      );

    new Setting(containerEl)
      .setName("History limit")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.historyLimit))
          .onChange(async (value) => {
            this.plugin.settings.historyLimit = Math.max(10, Math.floor(parseNumber(value, 200)));
            await this.plugin.savePluginData();
          })
      );

    new Setting(containerEl)
      .setName("Staleness days")
      .setDesc("Days until a note gets full staleness boost.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.stalenessDays))
          .onChange(async (value) => {
            this.plugin.settings.stalenessDays = Math.max(0, parseNumber(value, 14));
            await this.plugin.savePluginData();
          })
      );

    new Setting(containerEl)
      .setName("Max staleness boost")
      .setDesc("Maximum multiplier added for stale notes.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.maxStalenessBoost))
          .onChange(async (value) => {
            this.plugin.settings.maxStalenessBoost = Math.max(0, parseNumber(value, 1));
            await this.plugin.savePluginData();
          })
      );

    new Setting(containerEl)
      .setName("Diversity window")
      .setDesc("Avoid repeating recent topics within this many picks.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.diversityWindow))
          .onChange(async (value) => {
            this.plugin.settings.diversityWindow = Math.max(0, Math.floor(parseNumber(value, 3)));
            await this.plugin.savePluginData();
          })
      );

    new Setting(containerEl)
      .setName("Same topic penalty")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.sameTopicPenalty))
          .onChange(async (value) => {
            this.plugin.settings.sameTopicPenalty = clamp(parseNumber(value, 0.7), 0.01, 1);
            await this.plugin.savePluginData();
          })
      );

    new Setting(containerEl)
      .setName("Same subtopic penalty")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.sameSubtopicPenalty))
          .onChange(async (value) => {
            this.plugin.settings.sameSubtopicPenalty = clamp(parseNumber(value, 0.8), 0.01, 1);
            await this.plugin.savePluginData();
          })
      );

    containerEl.createEl("h3", { text: "Quality of life" });

    new Setting(containerEl)
      .setName("Snooze days")
      .setDesc("How long Snooze hides a note.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.snoozeDays))
          .onChange(async (value) => {
            this.plugin.settings.snoozeDays = Math.max(0, parseNumber(value, 1));
            await this.plugin.savePluginData();
          })
      );

    new Setting(containerEl)
      .setName("Auto open on pick")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoOpenOnPick).onChange(async (value) => {
          this.plugin.settings.autoOpenOnPick = value;
          await this.plugin.savePluginData();
        })
      );

    new Setting(containerEl)
      .setName("Open in new leaf")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.openInNewLeaf).onChange(async (value) => {
          this.plugin.settings.openInNewLeaf = value;
          await this.plugin.savePluginData();
        })
      );

    new Setting(containerEl)
      .setName("Auto mark in progress on open")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoMarkInProgressOnOpen).onChange(async (value) => {
          this.plugin.settings.autoMarkInProgressOnOpen = value;
          await this.plugin.savePluginData();
        })
      );

    new Setting(containerEl)
      .setName("Reveal in file explorer on open")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.revealInFileExplorer).onChange(async (value) => {
          this.plugin.settings.revealInFileExplorer = value;
          await this.plugin.savePluginData();
        })
      );

    new Setting(containerEl)
      .setName("Write last reviewed to frontmatter")
      .setDesc("Writes a timestamp whenever a note is opened or marked.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.writeLastReviewed).onChange(async (value) => {
          this.plugin.settings.writeLastReviewed = value;
          await this.plugin.savePluginData();
        })
      );

    new Setting(containerEl)
      .setName("Last reviewed field")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.lastReviewedField)
          .onChange(async (value) => {
            this.plugin.settings.lastReviewedField = value.trim() || "last-reviewed";
            await this.plugin.savePluginData();
          })
      );

    containerEl.createEl("h3", { text: "Help" });
    const help = containerEl.createDiv({ cls: "rmv-settings-help" });
    help.createEl("p", {
      text:
        "Next picks a new condition using rank + progress heuristics. Open opens the current pick. Done/In Progress/Not Started update the note status. Snooze hides the pick for a few days. Copy link copies a wiki link. Reveal focuses the file in the explorer.",
    });
    help.createEl("p", {
      text:
        "Daily flow: open the panel, hit Next, study the note, mark In Progress or Done, and repeat. Snooze anything you cannot tackle today. Use the target folder to switch rotations fast.",
    });
  }
}

class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
  onChoose: (folder: TFolder) => void;

  constructor(app: App, onChoose: (folder: TFolder) => void) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder("Select a folder");
  }

  getItems(): TFolder[] {
    return this.app.vault
      .getAllLoadedFiles()
      .filter((file): file is TFolder => file instanceof TFolder);
  }

  getItemText(item: TFolder): string {
    return item.path || "/";
  }

  onChooseItem(item: TFolder): void {
    this.onChoose(item);
  }
}

function normalizeTargetFolder(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  return normalizePath(trimmed);
}

function normalizeStatus(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase();
}

function normalizeString(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (value === null || value === undefined) {
    return "";
  }
  return String(value);
}

function normalizeList(values: string[]): string[] {
  return values
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function parseNumber(value: string, fallback: number): number {
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return parsed;
}

function formatRelativeTime(ts: number): string {
  if (!ts) {
    return "never";
  }
  const diff = Date.now() - ts;
  if (diff < 60_000) {
    return "just now";
  }
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 14) {
    return `${days}d ago`;
  }
  const weeks = Math.floor(days / 7);
  if (weeks < 8) {
    return `${weeks}w ago`;
  }
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}
