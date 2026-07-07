// SPDX-License-Identifier: Apache-2.0
// Regression guard for the onnxruntime-node bundling P0.
//
// The server-mode embedder (src/server/generation/embedder.ts) imports
// @huggingface/transformers, which pulls in onnxruntime-node — a package that
// requires prebuilt native `.node` binaries. esbuild has no loader for `.node`
// files, so any bundle that reaches the embedder must keep the embedding stack
// EXTERNAL, and the generated plugin/package.json must DECLARE
// @huggingface/transformers so `npm install --omit=dev` installs it (and its
// onnxruntime-node dep) at runtime. If either half regresses, `npm run build`
// fails (missing external) or the deployed server crashes at runtime with
// MODULE_NOT_FOUND (missing dependency).
//
// The strongest guard asserts on the EMITTED bundle — that is exactly what
// esbuild produces and what runs at deploy time. A bundle that reaches the
// embedder must (a) leave a bare `require("@huggingface/transformers")` for the
// runtime to resolve, and (b) contain none of onnxruntime-node's native binding
// source. We assert this against the tracked `plugin/scripts/server-service.cjs`
// (always present in the repo). We also assert the runtime dependency is
// declared and version-matched. An earlier source-text-parsing approach silently
// inspected the wrong esbuild `external` array, so we deliberately assert on the
// artifact and the manifest, not on build-hooks.js internals.
import { describe, it, expect } from 'bun:test';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

/** Bundles that transitively reach the embedder and are tracked in the repo. */
const EMITTED_BUNDLES = [
  // server-service: reaches the embedder statically (ServerService → routes →
  // observations.ts → embedder). Runs under bun, which loads onnxruntime-node's
  // .node binaries natively from plugin/node_modules at runtime.
  'plugin/scripts/server-service.cjs',
];

describe('Embedder bundling - emitted server bundle', () => {
  for (const rel of EMITTED_BUNDLES) {
    const abs = path.join(projectRoot, rel);

    it(`${rel} exists (build artifact is committed)`, () => {
      expect(existsSync(abs)).toBe(true);
    });

    it(`${rel} keeps @huggingface/transformers external (bare require, resolved at runtime)`, () => {
      const src = readFileSync(abs, 'utf-8');
      // A minified external CJS require of the package. If the embedder were
      // bundled instead, this literal require would be gone (inlined).
      expect(src).toMatch(/require\(["']@huggingface\/transformers["']\)/);
    });

    it(`${rel} does NOT bundle onnxruntime-node native binding source`, () => {
      const src = readFileSync(abs, 'utf-8');
      // These strings only appear when onnxruntime-node's binding.js is bundled
      // in (the exact thing that broke esbuild). Their absence proves the native
      // stack was externalized, not inlined.
      expect(src).not.toContain('onnxruntime_binding');
      expect(src).not.toContain('napi-v6');
    });
  }
});

describe('Embedder bundling - npx-cli artifact (when built)', () => {
  // dist/npx-cli/index.js is gitignored, so it may be absent in a fresh checkout
  // before `npm run build`. When present, it must obey the same contract: the
  // `server` command dynamically imports the Postgres storage layer → embedder,
  // and @huggingface/transformers is a ROOT runtime dependency, so `npx
  // memsmith` resolves it from node_modules at runtime.
  const abs = path.join(projectRoot, 'dist/npx-cli/index.js');

  it('does not bundle onnxruntime-node native binding source', () => {
    if (!existsSync(abs)) return; // not built in this checkout — skip
    const src = readFileSync(abs, 'utf-8');
    expect(src).not.toContain('onnxruntime_binding');
    expect(src).not.toContain('napi-v6');
  });
});

describe('Embedder bundling - runtime dependency declaration', () => {
  it('build-hooks.js declares @huggingface/transformers in the generated plugin/package.json', () => {
    // The dependency must be added to the pluginPackageJson.dependencies object
    // the build writes, so the deployed container installs it at runtime.
    const buildHooks = readFileSync(path.join(projectRoot, 'scripts/build-hooks.js'), 'utf-8');
    expect(buildHooks).toContain("'@huggingface/transformers': '^4.2.0'");
  });

  it('the generated plugin/package.json on disk declares @huggingface/transformers', () => {
    const pkg = JSON.parse(readFileSync(path.join(projectRoot, 'plugin/package.json'), 'utf-8'));
    expect(pkg.dependencies['@huggingface/transformers']).toBeDefined();
  });

  it('the plugin dependency version matches the root package.json version (no drift)', () => {
    const root = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'));
    const plugin = JSON.parse(readFileSync(path.join(projectRoot, 'plugin/package.json'), 'utf-8'));
    expect(plugin.dependencies['@huggingface/transformers']).toBe(
      root.dependencies['@huggingface/transformers'],
    );
  });
});
