/**
 * Build the Host half.
 *
 * The Host runs plain ES modules on Node with no build step of its own, so the
 * output must be authored to run as-is: TypeScript is stripped, and relative
 * imports keep their `.js` extensions so Node's ESM resolver finds them.
 *
 * `esbuild` is used rather than `tsc` because this half is bundled into the DSH
 * process: no source maps pointing at a machine that will not have them, and no
 * type declarations to ship.
 */

import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const project = resolve(root, '..');

rmSync(resolve(project, 'dist/host'), { recursive: true, force: true });

await build({
  entryPoints: [resolve(project, 'src/host/index.ts')],
  outfile: resolve(project, 'dist/host/index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  // The DSH packages are resolved by the Host at runtime; bundling them would
  // ship a second copy of the framework next to the one already running.
  external: ['@deepseek-ai/*'],
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  logLevel: 'info',
});

// The browser types are shared with the Host, so the shared contract module is
// emitted beside it for anyone reading the dist tree.
console.log('host build complete: dist/host/index.js');
