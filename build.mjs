import { build } from 'esbuild';
const shared = { bundle: true, sourcemap: false, minify: true, target: 'es2022', logLevel: 'info' };
await Promise.all([
  build({ ...shared, entryPoints: ['src/background/sw.ts'], outfile: 'dist/sw.js', format: 'esm' }),
  build({ ...shared, entryPoints: ['src/content/bridge-main.ts'], outfile: 'dist/bridge-main.js', format: 'iife' }),
  build({ ...shared, entryPoints: ['src/content/bridge-relay.ts'], outfile: 'dist/bridge-relay.js', format: 'iife' }),
  build({ ...shared, entryPoints: ['src/popup/popup.ts'], outfile: 'dist/popup.js', format: 'iife' }),
]);
