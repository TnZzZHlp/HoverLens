# HoverLens

A Tampermonkey userscript for image preview on double-Ctrl hover.

## Commands

```bash
pnpm dev      # Start Vite dev server
pnpm build    # Build userscript (runs tsc then vite build)
pnpm preview  # Preview production build
```

## Notes

- Uses pnpm (not npm/yarn). Run `pnpm install` for setup.
- No test/lint commands configured. TypeScript checking only via `tsc` in build.
- Output is a userscript in `dist/` (built with vite-plugin-monkey).
- CI auto-deploys to `release` branch on push to `main`.

## Architecture

- `src/main.ts` - Entry point with install guard
- `src/runtime.ts` - Bootstraps event listeners and modules
- `src/overlay.ts` - Image preview overlay
- `src/ai-panel.ts` - AI panel UI
- `src/hotkey.ts` - Double-Ctrl detection
