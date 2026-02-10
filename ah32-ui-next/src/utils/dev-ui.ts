// Dev UI master switch (single source of truth).
//
// Only `.env` `VITE_ENABLE_DEV_UI=true|false` controls whether dev UI is enabled.
// This avoids implicit behavior differences between `vite dev` and production builds.

export const isDevUiEnabled = (): boolean => {
  try {
    // NOTE: avoid optional chaining on `import.meta` so Vite can statically inject `import.meta.env`.
    const env = (import.meta as any).env || {}
    const raw = String(env.VITE_ENABLE_DEV_UI || '').trim().toLowerCase()
    return raw === '1' || raw === 'true' || raw === 'yes'
  } catch (e) {
    ;(globalThis as any).__ah32_reportError?.('ah32-ui-next/src/utils/dev-ui.ts', e)
    return false
  }
}
