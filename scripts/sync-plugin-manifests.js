#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const packageJsonPath = path.join(rootDir, 'package.json');
const codexPluginPath = path.join(rootDir, '.codex-plugin', 'plugin.json');
const bundledCodexPluginPath = path.join(rootDir, 'plugin', '.codex-plugin', 'plugin.json');
const bundledClaudePluginPath = path.join(rootDir, 'plugin', '.claude-plugin', 'plugin.json');
const marketplacePath = path.join(rootDir, '.claude-plugin', 'marketplace.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

function syncCodexPlugin(plugin, pkg) {
  return {
    ...plugin,
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    homepage: pkg.homepage,
    repository: normalizeRepositoryUrl(pkg.repository),
    license: pkg.license,
    keywords: pkg.keywords,
    author: normalizeAuthor(pkg.author),
    interface: {
      ...plugin.interface,
      developerName: normalizeAuthorName(pkg.author),
      websiteURL: normalizeRepositoryUrl(pkg.repository),
    },
  };
}

function syncClaudePlugin(plugin, pkg) {
  return {
    ...plugin,
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    homepage: pkg.homepage,
    repository: normalizeRepositoryUrl(pkg.repository),
    license: pkg.license,
    keywords: pkg.keywords,
    author: normalizeAuthor(pkg.author),
  };
}

function syncMarketplace(marketplace, pkg) {
  return {
    ...marketplace,
    plugins: (marketplace.plugins ?? []).map((plugin) =>
      plugin.name === pkg.name
        ? { ...plugin, version: pkg.version, description: pkg.description }
        : plugin,
    ),
  };
}

function normalizeAuthor(author) {
  if (author && typeof author === 'object') {
    return author.url ? { name: author.name, url: author.url } : { name: author.name };
  }
  return { name: normalizeAuthorName(author) };
}

function normalizeAuthorName(author) {
  if (typeof author === 'string') return author;
  if (author && typeof author === 'object' && typeof author.name === 'string') return author.name;
  return '';
}

function normalizeRepositoryUrl(repository) {
  if (typeof repository === 'string') return repository.replace(/^git\+/, '').replace(/\.git$/, '');
  if (repository && typeof repository === 'object' && typeof repository.url === 'string')
    return repository.url.replace(/^git\+/, '').replace(/\.git$/, '');
  return '';
}

function main() {
  for (const filePath of [packageJsonPath, codexPluginPath, bundledCodexPluginPath, bundledClaudePluginPath, marketplacePath]) {
    if (!fs.existsSync(filePath)) {
      console.error(`Missing required file: ${filePath}`);
      process.exit(1);
    }
  }

  const pkg = readJson(packageJsonPath);
  const codexPlugin = readJson(codexPluginPath);
  const bundledCodexPlugin = readJson(bundledCodexPluginPath);
  const bundledClaudePlugin = readJson(bundledClaudePluginPath);

  writeJson(codexPluginPath, syncCodexPlugin(codexPlugin, pkg));
  writeJson(bundledCodexPluginPath, syncCodexPlugin(bundledCodexPlugin, pkg));
  writeJson(bundledClaudePluginPath, syncClaudePlugin(bundledClaudePlugin, pkg));
  writeJson(marketplacePath, syncMarketplace(readJson(marketplacePath), pkg));

  console.log('✓ Synced plugin manifests from package.json');
}

main();
