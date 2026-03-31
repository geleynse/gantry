import * as esbuild from 'esbuild';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Glob } from 'bun';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isWatch = process.argv.includes('--watch');
const isBinary = process.argv.includes('--binary');

// Read build-time constants to bake into the bundle.
// These replace process.env lookups so the compiled bundle has real values
// even when deployed to a machine with no .git directory or package.json.
function readBuildVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8')) as Record<string, unknown>;
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function readGitCommit(): string {
  try {
    const proc = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: __dirname });
    if (proc.exitCode !== 0) return 'unknown';
    return proc.stdout.toString().trim().slice(0, 7);
  } catch {
    return 'unknown';
  }
}

const buildVersion = readBuildVersion();
const gitCommit = readGitCommit();
console.log(`Build info: version=${buildVersion} commit=${gitCommit}`);

// Server bundle (esbuild)
// Client is built separately via `next build` (see package.json build:client)
const serverBuild: esbuild.BuildOptions = {
  entryPoints: [resolve(__dirname, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: resolve(__dirname, 'dist/index.js'),
  sourcemap: true,
  external: ['node:*', 'bun:sqlite', 'ws', 'socks'],
  define: {
    'process.env.BUILD_VERSION': JSON.stringify(buildVersion),
    'process.env.GIT_COMMIT': JSON.stringify(gitCommit),
  },
};

async function buildBinary() {
  // Produce a standalone bun binary with static frontend assets embedded.
  // We generate a TypeScript file that imports each asset with { type: "file" },
  // which tells Bun to embed them. At runtime they're available via
  // Bun.embeddedFiles. The app.ts static-file middleware detects embedded
  // mode and serves from memory instead of disk.
  const outBin = resolve(__dirname, 'dist/gantry');
  console.log('Building standalone binary...');

  // Collect all static frontend files to embed
  const publicFiles: string[] = [];
  const publicGlob = new Glob('dist/public/**/*');
  for await (const entry of publicGlob.scan({ cwd: __dirname, onlyFiles: true })) {
    publicFiles.push(entry);
  }

  console.log(`Embedding ${publicFiles.length} static files from dist/public/`);

  // Generate a module that imports every file with { type: "file" }.
  // This is the supported way to embed arbitrary files (including .html)
  // in a Bun compiled binary — CLI args treat .html as entry points.
  const imports = publicFiles
    .map((f, i) => {
      // Manifest is in dist/, so strip the dist/ prefix for relative imports
      const relPath = f.startsWith('dist/') ? './' + f.slice('dist/'.length) : './' + f;
      return `import f${i} from "${relPath}" with { type: "file" };`;
    })
    .join('\n');
  const manifest = `${imports}\nexport default [${publicFiles.map((_, i) => `f${i}`).join(', ')}];\n`;
  const manifestPath = resolve(__dirname, 'dist/_embedded-assets.ts');
  writeFileSync(manifestPath, manifest);

  const proc = Bun.spawn(
    [
      'bun',
      'build',
      '--compile',
      '--target=bun',
      `--define:process.env.BUILD_VERSION=${JSON.stringify(buildVersion)}`,
      `--define:process.env.GIT_COMMIT=${JSON.stringify(gitCommit)}`,
      resolve(__dirname, 'src/index.ts'),
      manifestPath,
      `--outfile=${outBin}`,
    ],
    {
      cwd: __dirname,
      stdout: 'inherit',
      stderr: 'inherit',
    }
  );
  const code = await proc.exited;
  if (code !== 0) {
    console.error('Binary build failed');
    process.exit(code);
  }
  console.log(`Binary written to: ${outBin}`);
}

async function build() {
  // Ensure dist directory exists
  mkdirSync(resolve(__dirname, 'dist'), { recursive: true });

  if (isBinary) {
    await buildBinary();
    return;
  }

  if (isWatch) {
    const serverCtx = await esbuild.context(serverBuild);
    await serverCtx.watch();
    console.log('Watching for server changes...');
  } else {
    await esbuild.build(serverBuild);
    console.log('Server build complete');
  }
}

build().catch((e) => {
  console.error(e);
  process.exit(1);
});
