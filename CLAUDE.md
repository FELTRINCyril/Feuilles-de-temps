# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Purpose

Local web app for tracking time with an interrupt-stack workflow, optimized for Odoo timesheet reporting. Tracks time in 15-minute increments with pause/resume support for task interruptions. Exports to CSV for Odoo import.

## Architecture

```
[React + TS + Vite]  <--REST API-->  [Express + TS + Node]  <--fs-->  [data/*.json]
     (client/)           :5173           (server/)            :3001
                  [Electron shell: tray + popup]
                              (electron/)
```

- **Monorepo** with npm workspaces: `client/`, `server/`, plus `electron/` (desktop shell)
- **Runtime:** Node 26 + npm (workspaces). Server dev runs via `tsx watch`.
- **Desktop:** Electron (`electron/main.js`). The Express server runs in-process in Electron main (bundled to `electron/server-bundle.mjs` by esbuild). Tray and frameless tray-popup are in `electron/`. Renderer talks to main via `client/src/desktop.ts` + `electron/preload.cjs` (IPC `set-tray-title`, `close-tray-popup`). Packaging via electron-builder (`npm run build:app`, output in `dist-electron/`). Packaged app data dir: `~/Library/Application Support/com.timesheet.tracker/` (kept from the old Tauri app).
- **Frontend:** React 19 + TypeScript + Vite. Proxy in vite.config.ts forwards `/api` to server.
- **Backend:** Express + TypeScript. App factory pattern (`createApp(dataDir)` in `server/src/app.ts`).
- **Storage:** JSON files in `data/` — one file per day (`YYYY-MM-DD.json`) + `projects.json` for the project/task registry.
- **Tests:** Vitest for both client and server. Backend tests use supertest with isolated data directories per suite to avoid parallel test conflicts.

## Commands

```bash
npm install          # Install all workspaces
npm run dev          # Start both servers (concurrently)
npm run dev:server   # Server only (port 3001, tsx watch)
npm run dev:client   # Client only (port 5173)
npm run test         # Run all tests
npm run test:server  # Server tests only
npm run test:client  # Client tests only

npm run dev:electron # Electron app in dev (vite + electron --dev)
npm run build:app    # Package the macOS app (electron-builder -> dist-electron/)
npm run install:app  # Copy Tempo.app to /Applications and launch it

# Run a single server test file:
cd server && npx vitest run src/__tests__/timesheet.test.ts

# Watch mode:
cd server && npx vitest src/__tests__/timesheet.test.ts
```

## Key Patterns

- **Router factories:** Each route file exports a `createXxxRouter(storage)` function. Mounted in `app.ts`.
- **Storage class:** `server/src/storage.ts` — handles all JSON file I/O. Injected into routers via constructor.
- **Time utils:** `server/src/time-utils.ts` — `roundUp15()`, `calcSegmentMinutes()`, `calcTotalMinutes()`, `nowHHmm()`.
- **Types duplicated:** `server/src/types.ts` and `client/src/types.ts` are identical copies (no shared package).
- **API client:** `client/src/api.ts` — typed fetch wrapper for all endpoints.
- **Timer logic:** Server stores segment start/end timestamps. Frontend computes elapsed time client-side via `setInterval(1000)` from last open segment's `start`.

## Data Model

- **Customers:** `{ id, name, type: 'interne'|'externe', archived? }` in `customers.json`
- **Activities:** `{ id, name, customerId, archived? }` in `activities.json` (migrated from the legacy `projects.json`)
- **Timesheet entries:** `{ id, activityId, description, segments: [{ start, end }], totalMinutes, roundedMinutes, status: 'active'|'paused'|'completed', deferred?, deleted?, autoPausedAt?, autoPauseReason?, recoveredAt?, splitAtMidnight?, continuedFrom? }`
- **Day file:** `{ date, entries[], activeEntries: id[], pausedEntries: id[] }`
- **`runtime.json`:** `{ lastSeenAt }` — heartbeat written every 30 s by the Electron main process

## Business Rules

- Time rounded up to nearest 15 minutes on completion
- Multiple timers can run simultaneously; pause/resume is manual (no automatic LIFO stack)
- Timer survives browser refresh (computed from stored timestamps, not intervals)

### Nothing is ever destroyed

- **Entries are soft-deleted** (`deleted: true`), never removed from the day file. `POST .../restore` brings them back. Filter `!e.deleted` in any new read path (export, stats, UI).
- **Merge** soft-deletes its originals and recomputes durations server-side from the stored entries. Never trust durations sent by the client.
- **Activities and customers used by past entries are archived** (`archived: true`), not deleted, so history keeps its labels. `DELETE` returns `{ archived: boolean }` to say what happened. Archived items are hidden from the pickers but still resolve names in the UI, CSV and stats.

### Writing to a day file

Always go through `storage.withTimesheet(date, fn)`. It takes an exclusive lock per file, so read-modify-write is safe (two windows plus the popup write concurrently). Return `false` from `fn` to skip the write. Never do `loadTimesheet` + `saveTimesheet` in a route: that loses concurrent updates.

### A timer must never count time that was not worked

`server/src/routes/system.ts` owns the rules, `electron/main.js` reports what macOS does:

- `powerMonitor` suspend / lock-screen -> `POST /api/system/suspend` closes open segments and marks `autoPausedAt`
- resume / unlock-screen -> `POST /api/system/resume` restarts only what it paused itself less than 2 min ago; longer absences stay paused
- quit -> same pause path with `reason: 'quit'` (the quit is deferred until it is written)
- startup -> `POST /api/system/recover` closes segments orphaned by a crash at `runtime.json`'s `lastSeenAt`, not at now
- midnight (and after waking) -> `POST /api/system/rollover` closes the day's timer at 23:59:59, completes it, and creates a continuation entry at 00:00:00 on the next day

### Menu bar title

Owned by the tray popup renderer only (it is always alive and always on today). Its window runs with `backgroundThrottling: false` so the 1 s tick keeps running while hidden. `TrackerPage` must not write the tray title: it can be showing any date.
