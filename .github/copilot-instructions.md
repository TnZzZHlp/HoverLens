# Project Guidelines

## Code Style
- Use TypeScript with strict typing and keep changes compatible with `strict` mode and no-unused compiler checks in `tsconfig.json`.
- Prefer small function-based modules (current codebase style) over introducing classes unless a task explicitly needs them.
- Keep shared contracts in `src/types.ts`; use `import type` where appropriate.
- Follow existing comment style in surrounding files (many modules use concise Chinese comments).

## Architecture
- Keep bootstrap and install guard logic in `src/main.ts`.
- Keep global event orchestration in `src/runtime.ts`.
- Keep image URL detection/extraction logic in `src/image.ts`.
- Keep overlay UI, zoom, drag, and open/close interactions in `src/overlay.ts`.
- Keep configurable behavior in `src/config.ts` and mutable singleton runtime state in `src/state.ts`.
- Keep reusable browser-safe helpers in `src/utils.ts`.

## Build and Test
- Use `pnpm` for dependency and script execution.
- Dev server: `pnpm dev`
- Build: `pnpm build` (runs `tsc && vite build`)
- Preview bundle: `pnpm preview`
- CI reference: `.github/workflows/build-and-push-release.yml` (Node 22, pnpm 9, publish `dist/` to `release` branch).
- There is currently no dedicated test or lint script; validate changes with a successful build and targeted manual behavior checks.

## Conventions
- Preserve hotkey safety rules that avoid triggering in editable/editor contexts (see `src/hotkey.ts`).
- Preserve the runtime UX contract: double `Ctrl` toggles preview, `Escape` closes preview (`src/runtime.ts`).
- For URL handling, reuse `normalizeImageUrl`/`resolveUrl` helpers instead of adding ad-hoc parsing.
- Keep overlay IDs and style IDs config-driven via `CONFIG` (avoid hardcoded duplicates outside config).
- Prefer minimal dependency additions; keep the userscript bundle lean.