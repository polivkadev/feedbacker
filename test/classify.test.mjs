import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFile } from '../src/core.mjs';

const kind = (p, extra = {}) => classifyFile({ path: p, ...extra });

test('classifyFile: tests in many languages', () => {
  for (const p of [
    'src/app.test.ts', 'src/app.spec.ts', 'src/app.spec.js', 'src/App.spec.tsx', 'lib/x.test.mjs', 'e2e/login.e2e.ts',
    'cypress/login.cy.ts', 'src/Button.stories.tsx', 'test/core.mjs', 'tests/test_api.py', 'pkg/api_test.go',
    'src/test/java/com/x/FooTest.java', 'app/src/test/kotlin/FooTests.kt', 'Tests/FooTests.cs', 'spec/user_spec.rb',
    '__tests__/a.js', 'src/__mocks__/fs.js', 'testdata/input.json', 'test_utils.py', 'crates/x/tests/it.rs',
  ]) assert.equal(kind(p), 'test', p);
});

test('classifyFile: code stays code', () => {
  for (const p of ['src/server.ts', 'bin/feedbacker.mjs', 'src/contest.py', 'src/latest.go', 'src/protest/main.c', 'lib/Testing.java', 'Dockerfile.go']) {
    assert.equal(kind(p), 'code', p);
  }
});

test('classifyFile: docs, config, generated', () => {
  for (const p of ['README.md', 'CLAUDE.md', 'AGENTS.md', 'docs/setup.png.txt', 'docs/guide.rst', 'LICENSE', 'CHANGELOG.md']) assert.equal(kind(p), 'docs', p);
  for (const p of ['package.json', '.github/workflows/ci.yml', 'deploy/compose.yaml', 'Cargo.toml', '.gitignore', 'Dockerfile', 'Makefile', 'tsconfig.json']) assert.equal(kind(p), 'config', p);
  for (const p of ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'Cargo.lock', 'go.sum', 'poetry.lock', 'src/dist/app.js', 'public/vendor.min.js', 'x.js.map', '__snapshots__/a.snap']) assert.equal(kind(p), 'generated', p);
  assert.equal(kind('logo.png', { binary: true }), 'generated');
});
