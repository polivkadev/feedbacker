// Bundle the review page (src/ui: React, styles, fonts) into src/dist, which is committed so users
// need no build step. Run `pnpm build` after changing src/ui;
// `node build.mjs --out DIR` writes elsewhere (the tests use it to check that
// the committed bundle is up to date).

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const outIdx = process.argv.indexOf('--out');
const out = outIdx > 0 ? path.resolve(process.argv[outIdx + 1]) : path.join(root, 'src', 'dist');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
await esbuild.build({
  entryPoints: [path.join(root, 'src', 'ui', 'app.jsx')],
  outfile: path.join(out, 'app.js'),
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2020',
  jsx: 'automatic',
  loader: { '.woff2': 'file' },
  assetNames: 'fonts/[name]-[hash]',
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
});

fs.copyFileSync(path.join(root, 'src', 'ui', 'favicon.svg'), path.join(out, 'favicon.svg'));

// Licences of everything in the bundle.
const licences = ['react', 'react-dom', 'scheduler', 'highlight.js', '@fontsource-variable/atkinson-hyperlegible-next', '@fontsource-variable/jetbrains-mono'].map((name) => {
  const dir = path.dirname(require.resolve(`${name}/package.json`, { paths: [path.dirname(require.resolve('react-dom/package.json'))] }));
  const { version } = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  return `${name} ${version}\n\n${fs.readFileSync(path.join(dir, 'LICENSE'), 'utf8').trim()}\n`;
});
fs.writeFileSync(path.join(out, 'THIRD_PARTY_LICENSES.txt'), 'Bundled in app.js, app.css and fonts/:\n\n' + licences.join('\n' + '-'.repeat(72) + '\n\n'));
