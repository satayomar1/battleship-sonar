import { defineConfig } from 'vitest/config';

// The Supabase security suite (supabase/__tests__/security.test.ts) boots a
// real Postgres (PGlite WASM) per run; on low-memory machines a vitest worker
// cannot fit the WASM compile alongside vite and dies with a V8 Zone OOM.
// Default `npm test` therefore covers only the engine/lib suites. Verify the
// migrations with:
//   npm run verify:migrations
export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      'supabase/**',
    ],
  },
});
