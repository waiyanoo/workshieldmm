import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      /**
       * Resolve @hyper/shared to its TypeScript source rather than its build.
       *
       * The package targets Node and compiles to CommonJS (tsconfig.base sets
       * `module: CommonJS`), which the API consumes happily. A browser cannot:
       * the compiled `index.js` re-exports through tsc's `__exportStar` helper,
       * which copies properties in a loop, so nothing can statically see the
       * named exports and every `import { X } from "@hyper/shared"` fails at
       * runtime with "does not provide an export named X".
       *
       * Pointing at the source sidesteps it — Vite compiles the TS itself, the
       * web gets HMR on shared code, and `npm run build:shared` stops being a
       * prerequisite for the front end to pick up a change. The alternative,
       * dual ESM/CJS output from the package, is more moving parts for a
       * benefit only a published package would see.
       */
      "@hyper/shared": fileURLToPath(
        new URL("../../packages/shared/src/index.ts", import.meta.url)
      ),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
