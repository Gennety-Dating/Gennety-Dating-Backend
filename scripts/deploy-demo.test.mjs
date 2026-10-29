import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, existsSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('demo sync preserves dependencies and provisioned media from a clean export', () => {
  const script = readFileSync(new URL('./deploy-demo.sh', import.meta.url), 'utf8');
  const excludes = script.match(/^RSYNC_EXCLUDES=\([\s\S]*?^\)/m)?.[0];
  assert.ok(excludes);
  const root = mkdtempSync(join(tmpdir(), 'gennety-demo-sync-'));
  try {
    const source = join(root, 'source');
    const target = join(root, 'target');
    const file = (base, path, content) => {
      mkdirSync(join(base, path, '..'), { recursive: true });
      writeFileSync(join(base, path), content);
    };
    mkdirSync(source);
    symlinkSync('/missing-local-dependencies', join(source, 'node_modules'));
    file(source, 'apps/bot/src/index.ts', 'current source');
    file(target, 'node_modules/installed.txt', 'server dependencies');
    file(target, 'apps/bot/node_modules/installed.txt', 'workspace dependencies');
    file(target, '.env', 'server config');
    file(target, 'keys/server.p8', 'server key fixture');
    for (const folder of ['welcome-gift', 'verify-skip', 'delete-freeze']) {
      file(target, `apps/bot/src/assets/${folder}/media.bin`, 'provisioned media');
    }
    file(target, 'apps/bot/src/retired.ts', 'stale source');
    execFileSync('bash', ['-c', `${excludes}\nexec rsync -a --delete "\${RSYNC_EXCLUDES[@]}" "$1/" "$2/"`, 'sync-test', source, target]);
    assert.ok(lstatSync(join(target, 'node_modules')).isDirectory());
    assert.equal(readFileSync(join(target, 'node_modules/installed.txt'), 'utf8'), 'server dependencies');
    assert.ok(existsSync(join(target, 'apps/bot/node_modules/installed.txt')));
    assert.ok(existsSync(join(target, '.env')));
    assert.ok(existsSync(join(target, 'keys/server.p8')));
    for (const folder of ['welcome-gift', 'verify-skip', 'delete-freeze']) {
      assert.ok(existsSync(join(target, `apps/bot/src/assets/${folder}/media.bin`)));
    }
    assert.equal(readFileSync(join(target, 'apps/bot/src/index.ts'), 'utf8'), 'current source');
    assert.equal(existsSync(join(target, 'apps/bot/src/retired.ts')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
