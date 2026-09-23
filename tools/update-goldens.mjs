// Regenerates every golden PNG from the current renderer output.
//
// Review the regenerated PNGs visually before committing: update mode accepts
// whatever the renderer produces, including regressions.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Run vitest's own entry via the current node binary: spawning "npx.cmd"
// throws EINVAL on Node >=20.12/22 (the CVE-2024-27980 fix refuses .cmd
// without a shell), which made this tool fail silently on Windows.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vitestBin = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');

const result = spawnSync(
    process.execPath,
    [vitestBin, 'run', 'tests/golden/golden.test.ts'],
    { stdio: 'inherit', cwd: root, env: { ...process.env, IPL_UPDATE_GOLDEN: '1' } },
);

if (result.error) {
    console.error('update-goldens failed to spawn vitest:', result.error);
    process.exit(1);
}
process.exit(result.status ?? 1);
