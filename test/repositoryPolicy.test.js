import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const maintainedMarkdown = [
  'README.md',
  'architecture.md',
  'docs/SECURITY.md',
  'docs/DATABASE-OPERATIONS.md',
  'docs/HOME-ASSISTANT-EVENTS.md'
];
const currentVersionRoots = ['package.json', ...maintainedMarkdown, 'public', 'src', 'scripts'];
const supportedDatabaseCommands = ['db:backup', 'db:verify', 'db:restore', 'db:prune-pours'];

function readRepositoryFile(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
}

function currentVersionFiles() {
  const files = [];
  const collect = (relativePath) => {
    const absolutePath = path.join(repositoryRoot, relativePath);
    const entry = fs.statSync(absolutePath);
    if (entry.isDirectory()) {
      for (const child of fs.readdirSync(absolutePath)) collect(path.join(relativePath, child));
      return;
    }
    files.push(relativePath);
  };

  for (const root of currentVersionRoots) collect(root);
  return files.sort();
}

function isInsideRepository(candidate) {
  const relative = path.relative(repositoryRoot, candidate);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function relativeMarkdownTargets(markdown) {
  const targets = [];
  const linkPattern = /!?\[[^\]]*\]\(([^)]+)\)/g;

  for (const match of markdown.matchAll(linkPattern)) {
    const rawTarget = match[1].trim().replace(/^<|>$/g, '');
    const target = rawTarget.split(/[?#]/, 1)[0];

    if (target && !target.startsWith('#') && !/^[a-z][a-z\d+.-]*:/i.test(target) && !target.startsWith('//')) {
      targets.push(target);
    }
  }

  return targets;
}

test('package and lockfile agree on the application version', () => {
  const manifest = JSON.parse(readRepositoryFile('package.json'));
  const lockfile = JSON.parse(readRepositoryFile('package-lock.json'));

  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
  assert.equal(lockfile.version, manifest.version);
  assert.equal(lockfile.packages[''].version, manifest.version);
});

test('package.json is the sole current application version source', () => {
  const semanticVersion = '\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?';
  const applicationVersionPattern = new RegExp(
    `(?:"version"\\s*:\\s*"${semanticVersion}"|\\b(?:Home Assistant )?Tap\\s*Board\\b[^\\n]{0,80}\\bv?${semanticVersion}\\b|\\bversion\\s*(?:is\\s+|[:=]\\s*)v?${semanticVersion}\\b)`,
    'i'
  );
  const sources = currentVersionFiles()
    .filter((relativePath) => {
      const file = path.join(repositoryRoot, relativePath);
      return fs.statSync(file).isFile() && !fs.readFileSync(file).includes(0);
    })
    .filter((relativePath) => applicationVersionPattern.test(readRepositoryFile(relativePath)));

  assert.deepEqual(sources, ['package.json']);
});

test('relative links in maintained Markdown resolve inside the repository', () => {
  for (const markdownFile of maintainedMarkdown) {
    for (const target of relativeMarkdownTargets(readRepositoryFile(markdownFile))) {
      const resolved = path.resolve(repositoryRoot, path.dirname(markdownFile), target);
      assert.ok(isInsideRepository(resolved), `${markdownFile} links outside the repository: ${target}`);
      assert.ok(fs.existsSync(resolved), `${markdownFile} links to a missing path: ${target}`);
    }
  }
});

test('documented database-maintenance commands are supported npm scripts', () => {
  const manifest = JSON.parse(readRepositoryFile('package.json'));
  const operations = readRepositoryFile('docs/DATABASE-OPERATIONS.md');

  for (const command of supportedDatabaseCommands) {
    assert.ok(manifest.scripts[command], `package.json is missing ${command}`);
    assert.match(
      operations,
      new RegExp(`\\bnpm run ${command}\\b`),
      `DATABASE-OPERATIONS.md does not document ${command}`
    );
  }
});

test('unsafe direct database scripts have been retired', () => {
  for (const relativePath of ['src/checkTaps.js', 'src/enableTap4.js']) {
    assert.equal(fs.existsSync(path.join(repositoryRoot, relativePath)), false, `${relativePath} must be absent`);
  }
});

test('compact dashboard reserves the dynamic viewport for header, cards, and On Deck without scrolling', () => {
  const styles = readRepositoryFile('public/styles.css');

  assert.match(styles, /body\[data-layout-mode='compact'\]\s*\{[^}]*height:\s*100dvh;[^}]*overflow:\s*hidden;/s);
  assert.match(
    styles,
    /body\[data-layout-mode='compact'\] \.main-content\s*\{[^}]*flex:\s*1 1 0;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s
  );
  assert.match(styles, /body\[data-layout-mode='compact'\] \.tap-grid\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0;/s);
  assert.match(styles, /\.ondeck-ticker-container\[hidden\]\s*\{[^}]*display:\s*none;/s);
});

test('cozy landscape uses a shrinkable dynamic-viewport flex chain and preserves card content', () => {
  const styles = readRepositoryFile('public/styles.css');

  assert.match(
    styles,
    /body\[data-layout-mode='cozy'\]\s*\{[^}]*height:\s*100dvh;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s
  );
  assert.match(
    styles,
    /body\[data-layout-mode='cozy'\] \.main-content\s*\{[^}]*display:\s*flex;[^}]*flex:\s*1 1 0;[^}]*flex-direction:\s*column;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s
  );
  assert.match(styles, /body\[data-layout-mode='cozy'\] \.tap-grid\s*\{[^}]*flex:\s*1 1 0;[^}]*min-height:\s*0;/s);
  assert.match(
    styles,
    /body\[data-layout-mode='cozy'\] \.tap-card\s*\{[^}]*display:\s*grid;[^}]*grid-template-rows:\s*auto auto minmax\(0, 1fr\);[^}]*min-height:\s*0;[^}]*overflow-y:\s*hidden;/s
  );
  assert.match(
    styles,
    /body\[data-layout-mode='cozy'\] \.tap-graphic-wrapper\s*\{[^}]*flex:\s*1 1 0;[^}]*height:\s*auto;[^}]*min-height:\s*0;/s
  );
  assert.match(
    styles,
    /@media \(max-height:\s*600px\)\s*\{[^]*body\[data-layout-mode='cozy'\] \.tap-card\s*\{[^}]*grid-template-columns:\s*minmax\(72px, 36%\) minmax\(0, 1fr\);/s
  );
  assert.doesNotMatch(styles, /body\[data-layout-mode='cozy'\] \.tap-card\s*\{[^}]*overflow-y:\s*auto;/s);
  assert.match(
    styles,
    /body\[data-layout-mode='cozy'\] \.app-header,\s*body\[data-layout-mode='cozy'\] \.ondeck-ticker-container\s*\{[^}]*flex:\s*0 0 auto;/s
  );
  assert.match(styles, /\.ondeck-ticker-container\[hidden\]\s*\{[^}]*display:\s*none;/s);
});
