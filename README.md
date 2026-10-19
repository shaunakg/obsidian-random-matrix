# Random Matrix (Obsidian Plugin)

Random Matrix takes the decision out of "what should I study next?" when you have a big matrix of condition notes (one note per condition, with `rank` and `status` in the frontmatter). It offers a few weighted options, you tap one, study it, mark it finished, and the next options appear.

## How it works

The panel (dice icon in the ribbon) has three parts:

- **Focus chips**: one per top-level folder under your matrix folder (e.g. GP, O&G, Paediatrics, Psychiatry), with the share of that rotation's past exam questions you've covered (or rank 1 finished/total without exam yield). Tap one to study only that rotation; shift-click to combine. "All" clears the focus.
- **Pick one**: three options by default, drawn so they come from different rotations and topics. Tap one to open it and make it your current note. **Pick for me** chooses one of them for you; **Shuffle** passes on all three and shows a new set (passed notes don't come back for 45 minutes, then return gradually over a day).
- **Studying**: the note you're on. **Finished** sets its status and brings back the choices. **Snooze** hides it for a couple of days. **Put back** returns it to the pool without finishing it.

Underneath is your progress per rank, how many you've finished today and this week, and (with an exam date set) the daily rate needed to finish rank 1.

### Exam yield

If notes have an `exam_yield` property (expected questions per 100 on past papers, from the exam-yield pipeline), picking is driven by it: a note's priority is its yield plus a small boost for matrix rank (R1 +0.1, R2 +0.03, R3 +0.01), so heavily examined notes come up most and an unexamined rank 1 still beats an unexamined rank 3. Cards show the exam tier (`E1`–`E4`, from `exam_rank`); hover for the yield and how many past papers it appeared in. The progress section leads with **Exam**: the share of past exam questions your finished notes cover, and focus chips show the same per rotation. Turn this off in settings to rank by matrix rank alone.

### Exam plan

Set an exam date and how many conditions you can realistically finish per day. That gives a capacity (days left × per day). The plan is the highest-priority unfinished notes that fit in it, and only those come up (notes tied at the cut-off share the remaining slots). With exam yield, the panel shows how much of the past exams finishing the plan would cover, and the daily rate needed to reach 80%. Without it, priority is matrix rank (rank 2 and 3 weighted 0.3 and 0.1 by default), so rank 1 fills the plan first.

If a focused rotation has fewer than five notes in the plan, or the plan's remaining notes are all on cooldown, choices fall back to the best notes outside it.

### What makes a note more or less likely

- Its priority (above), within the plan.
- **In progress** notes get a small boost (×1.25), so started work gets finished.
- **Recently opened**: hidden for 6 hours, then down-weighted and recovering over a few days.
- **Recently passed on**: hidden for 45 minutes, then down-weighted and recovering over about a day.
- **Variety**: notes sharing a topic or subtopic with the last three you opened are down-weighted.

Finished notes and snoozed notes are never offered. Completions are logged whenever a note's status changes to finished, however you change it (the panel, a command, the properties view, or sync from another device).

## Commands

- **Pick for me and open**: opens your current note, or picks one of the choices.
- **Mark this note finished** / **Mark this note finished and pick the next one**
- **Mark this note in progress**
- **Snooze this note**
- **Open panel**

## Settings

- **Matrix folder**: notes inside it with a rank field are the matrix.
- **Exam date**, **Conditions per day**: the exam plan above.
- **Choices offered**: 1–5. Set to 1 for a single pick.
- **Prioritise by exam yield**: on by default; uses `exam_yield` when notes have it.
- **Rank 2 / Rank 3 weight** (used without exam yield), **Snooze length**
- **Frontmatter**: field names for rank, status, topic and subtopic, and the status values written for finished and in progress. `finished`, `done`, `complete`, `completed` and `mastered` all count as finished. The exam yield field name is configurable too.

## Development

```sh
pnpm install
pnpm run dev    # watch build with inline sourcemaps
pnpm run build  # production build to main.js
```

- `main.ts`: plugin, panel view, settings, and the note index (kept in sync with the metadata cache).
- `src/engine.ts`: the picking logic, with no Obsidian imports, so it can be run from Node.
- `styles.css`: panel styles.

Pushing a new `manifest.json` version to `main` builds a GitHub release, which BRAT picks up.

## Installing with BRAT

1. Install the BRAT community plugin in Obsidian.
2. Run `BRAT: Add a beta plugin for testing` and paste `https://github.com/shaunakg/obsidian-random-matrix`.
3. Enable the plugin in Settings → Community plugins.

Upgrading from 0.1.x keeps your matrix folder, field names, snoozes and when each note was last opened. The old tuning settings (scatter, staleness, penalties) are replaced by the exam plan.
