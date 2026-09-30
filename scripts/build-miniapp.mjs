import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'public', 'miniapp');
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [path.join(root, 'miniapp/src/main.jsx')],
  bundle: true,
  minify: true,
  sourcemap: false,
  target: ['es2022'],
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  outfile: path.join(out, 'app.js'),
  loader: { '.css': 'css' },
  logLevel: 'info',
});

copyFileSync(path.join(root, 'miniapp/index.html'), path.join(out, 'index.html'));
console.log('Мини-аппа собрана в public/miniapp/');
