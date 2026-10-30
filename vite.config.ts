// Build the Client half as ONE self-contained module.
//
// The Host loads it with `window.__ModuleLoader__.load({ id, factory })`, so the
// output must be a single file that registers itself under the package name and
// that resolves `react` / `react-dom` from the shell, never bundles its own copy
// (two React copies in one page is the classic way a plugin breaks the host).

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { type Plugin, defineConfig } from 'vite';

const root = dirname(fileURLToPath(import.meta.url));
const PACKAGE_NAME = '@local/dsh-archctrl';

/**
 * Wrap the built entry in the loader call the Host expects.
 *
 * Vite emits an ES module; the loader wants a global registration. Keeping the
 * wrapper here means the source stays ordinary ESM that tests can import
 * directly, and the shipped file is the only thing that knows about the loader.
 */
function moduleLoaderWrapper(): Plugin {
  return {
    name: 'dsh-module-loader-wrapper',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type !== 'chunk' || !output.isEntry) continue;
        const chunk = output;

        // The bundle stays an ES module so `react` / `react-dom` remain real
        // imports, resolved by the shell's own module graph. The loader wants a
        // value synchronously, so the module registers itself on the global when
        // it evaluates and the factory reads that — no import rewriting, which is
        // what broke the previous attempt once Rolldown collapsed the file.
        // An IIFE references its externals as free variables; wrapping the body
        // in a factory that declares them from `require` gives the CJS shape the
        // official bundles use, without a second React copy.
        chunk.code = [
          `window.__ModuleLoader__.load({`,
          `\tid: ${JSON.stringify(PACKAGE_NAME)},`,
          `\tfactory: (require) => {`,
          `\t\tconst React = require('react');`,
          `\t\tconst ReactDOM = require('react-dom');`,
          `\t\tconst JSX = require('react/jsx-runtime');`,
          // Tailwind's output is inlined by Vite at the top of the IIFE, so this
          // wrapper adds no second stylesheet.
          chunk.code,
          `\t\tconst mod = globalThis.__archctrlModule;`,
          `\t\tif (mod === undefined) throw new Error('archctrl: bundle did not publish its module');`,
          `\t\treturn { inject: ['slots'], apply: mod.apply };`,
          `\t},`,
          `});`,
          '',
        ].join('\n');
        void fileName;
      }
    },
  };
}

export default defineConfig({
  root,
  plugins: [react(), tailwindcss(), moduleLoaderWrapper()],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    target: 'es2022',
    minify: 'esbuild',
    // One file, so the loader has exactly one URL to fetch.
    rollupOptions: {
      input: resolve(root, 'src/client/entry.tsx'),
      external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
      output: {
        entryFileNames: 'client.js',
        // ES module output keeps `react` a real import the wrapper can rewrite.
        // An IIFE would need those externals as parameters, and the loader has no
        // way to supply them.
        // A classic <script> cannot parse top-level `import`. The official
        // bundles are CJS-shaped for this reason: `require` inside the factory.
        // An IIFE gives the same shape once the externals are read from the
        // factory's own parameters.
        format: 'iife',
        inlineDynamicImports: true,
        globals: {
          react: 'React',
          'react-dom': 'ReactDOM',
          'react-dom/client': 'ReactDOM',
          'react/jsx-runtime': 'JSX',
        },
      },
    },
  },
});
