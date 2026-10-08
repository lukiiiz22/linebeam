import { build, context } from 'esbuild';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createThirdPartyNotices } from './notices.mjs';

const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['vscode'],
  sourcemap: true,
  metafile: true,
  logLevel: 'info',
  plugins: [{
    name: 'third-party-notices',
    setup(builder) {
      builder.onEnd(async (result) => {
        if (result.errors.length) return;
        const notices = await createThirdPartyNotices(result.metafile);
        await writeFile(join('dist', 'THIRD_PARTY_NOTICES.txt'), notices);
      });
    },
  }],
};

if (process.argv.includes('--watch')) {
  const watcher = await context(options);
  await watcher.watch();
} else {
  await build(options);
}
