# Random Matrix (Obsidian Plugin)

Random Matrix takes the decision out of "what should I study next?" when you have a big matrix of condition notes (one note per condition, with `rank` and `status` in the frontmatter). It offers a few weighted options, you tap one, study it, mark it finished, and the next options appear.

## How it works

The panel (dice icon in the ribbon) has three parts:

- **Focus chips**: one per top-level folder under your matrix folder (e.g. GP, O&G, Paediatrics, Psychiatry), with rank 1 finished/total. Tap one to study only that rotation; shift-click to combine. "All" clears the focus.
- **Pick one**: three options by default, drawn so they come from different rotations and topics. Tap one to open it and make it your current note. **Pick for me** chooses one of them for you; **Shuffle** passes on all three and shows a new set (passed notes don't come back for 45 minutes, then return gradually over a day).
- **Studying**: the note you're on. **Finished** sets its status and brings back the choices. **Snooze** hides it for a couple of days. **Put back** returns it to the pool without finishing it.

Underneath is your progress per rank, how many you've finished today and this week, and (with an exam date set) the daily rate needed to finish rank 1.

### Exam plan

Set an exam date and how many conditions you can realistically finish per day. That gives a capacity (days left × per day), which is spent on rank 1 first, then rank 2, then rank 3. If rank 1 alone exceeds your capacity, only rank 1 comes up. Without an exam date, rank 2 and 3 are mixed in by their weights (0.3 and 0.1 relative to rank 1 by default).

### What makes a note more or less likely

- Its rank's share of the plan, spread across the remaining notes of that rank.
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
- **Rank 2 / Rank 3 weight**, **Snooze length**
- **Frontmatter**: field names for rank, status, topic and subtopic, and the status values written for finished and in progress. `finished`, `done`, `complete`, `completed` and `mastered` all count as finished.

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
