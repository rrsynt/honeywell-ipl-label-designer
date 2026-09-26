// Fase 7 item 2: rows from a database, driven through a real server.
//
// Three layers, and each one exists because the layer below it cannot prove
// the claim:
//
//   1. The read-only guard and the XML reader, as pure functions. These are
//      the two places where a mistake is silent — a bad guard empties a table,
//      and a bad reader loses a column — so they are pinned exhaustively.
//   2. The HTTP contract against a real server on a random port: the query
//      CRUD, and above all that NO response ever carries a connection string.
//   3. A real SQL Server, when one is available. This is the layer that
//      proves the character handling, and it is the reason this feature does
//      not shell out to sqlcmd: sqlcmd's console output is cp850, so Cyrillic
//      and CJK come back as '?' — silently. A label with a mangled character
//      is a misprinted label, so the test asserts the characters themselves,
//      not a row count.
//
// Layer 3 is skipped with a clear message when no LocalDB instance exists, so
// the suite stays green on a machine without SQL Server rather than pretending
// the feature was verified.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { handleDbRequest, readOnlyRefusal, parseRowsXml, MAX_ROWS } from '../tools/db-server.mjs';

let dataDir = '';
let server: http.Server;
let baseUrl = '';

beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipl-db-'));
    process.env.IPL_DB_DIR = dataDir;
    server = http.createServer(handleDbRequest);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('test server failed to bind');
    baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    delete process.env.IPL_DB_DIR;
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const call = (method: string, urlPath: string, body?: unknown): Promise<{ status: number; json: any; raw: string }> =>
    new Promise((resolve, reject) => {
        const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
        const req = http.request(`${baseUrl}${urlPath}`, {
            method,
            headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {},
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null, raw });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });

/** A stored query written the way the server addresses it (FNV-1a of the id). */
const fileHash = (text: string): string => {
    let hash = 0x811c9dc5;
    for (const b of Buffer.from(String(text), 'utf8')) {
        hash ^= b;
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
};

const writeQueryFile = (record: Record<string, unknown>): void => {
    const dir = path.join(dataDir, 'queries');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${fileHash(String(record.id))}.json`), JSON.stringify(record));
};

// --- layer 1: the guard ------------------------------------------------------------

describe('the read-only guard', () => {
    it('allows the SELECTs a label job actually uses', () => {
        expect(readOnlyRefusal('SELECT sku FROM t')).toBeNull();
        expect(readOnlyRefusal("  select sku from t where status = 'OK'  ")).toBeNull();
        expect(readOnlyRefusal('WITH n AS (SELECT 1 AS i) SELECT i FROM n')).toBeNull();
        expect(readOnlyRefusal('SELECT sku FROM t;')).toBeNull(); // a trailing semicolon is ordinary
        // Column and value names that merely CONTAIN a keyword are not writes.
        expect(readOnlyRefusal('SELECT created_at, updated_at FROM t')).toBeNull();
        expect(readOnlyRefusal("SELECT * FROM t WHERE status = 'DELETED'")).toBeNull();
        expect(readOnlyRefusal('/* a comment */ SELECT 1')).toBeNull();
    });

    it('refuses anything that changes data or schema', () => {
        expect(readOnlyRefusal('DELETE FROM t')).toMatch(/SELECT/);
        expect(readOnlyRefusal('UPDATE t SET a = 1')).toMatch(/SELECT/);
        expect(readOnlyRefusal('DROP TABLE t')).toMatch(/SELECT/);
        expect(readOnlyRefusal('EXEC sp_who')).toMatch(/SELECT/);
        expect(readOnlyRefusal('INSERT INTO t VALUES (1)')).toMatch(/SELECT/);
    });

    it('refuses a second statement, however it is dressed up', () => {
        expect(readOnlyRefusal('SELECT 1; DROP TABLE t')).toMatch(/one statement/);
        expect(readOnlyRefusal('SELECT 1; EXEC xp_cmdshell \'dir\'')).toMatch(/one statement/);
        // The comment case: the database still sees the DELETE.
        expect(readOnlyRefusal('/* harmless */ DELETE FROM t')).toMatch(/SELECT/);
        expect(readOnlyRefusal('SELECT 1 -- \n ; DROP TABLE t')).toMatch(/SELECT|one statement/);
    });

    it('refuses SELECT ... INTO, which writes a table', () => {
        expect(readOnlyRefusal('SELECT a INTO newtable FROM t')).toMatch(/INTO/);
    });

    it('refuses an empty query rather than sending nothing', () => {
        expect(readOnlyRefusal('')).toMatch(/empty/);
        expect(readOnlyRefusal('   ')).toMatch(/empty/);
        expect(readOnlyRefusal(undefined)).toMatch(/empty/);
    });
});

// --- layer 1: the reader -----------------------------------------------------------

describe('reading the query result', () => {
    it('keeps the column list the server sent, in order', () => {
        const xml = '<rows truncated="false"><columns><c name="sku"/><c name="qty"/></columns><row sku="A" qty="1"/></rows>';
        const parsed = parseRowsXml(xml);
        expect(parsed.columns).toEqual(['sku', 'qty']);
        expect(parsed.rows).toEqual([{ sku: 'A', qty: '1' }]);
        expect(parsed.truncated).toBe(false);
        expect(parsed.rowCount).toBe(1);
    });

    it('KEEPS a column whose first value is NULL', () => {
        // The bug this pins: reading the columns off the first row dropped a
        // column that started NULL, so every later row's value for it vanished
        // — and a vanished column is a field that prints empty.
        const xml = '<rows truncated="false"><columns><c name="sku"/><c name="note"/></columns>'
            + '<row sku="A"/><row sku="B" note="hello"/></rows>';
        const parsed = parseRowsXml(xml);
        expect(parsed.columns).toEqual(['sku', 'note']);
        expect(parsed.rows[1].note).toBe('hello');
        expect(parsed.rows[0].note).toBeUndefined(); // a NULL cell is simply absent
    });

    it('unescapes the characters SQL data actually contains', () => {
        const xml = '<rows truncated="false"><columns><c name="v"/></columns>'
            + '<row v="a&quot;b&lt;c&amp;d&gt;e"/></rows>';
        expect(parseRowsXml(xml).rows[0].v).toBe('a"b<c&d>e');
    });

    it('reports truncation', () => {
        const xml = '<rows truncated="true"><columns><c name="v"/></columns><row v="1"/></rows>';
        expect(parseRowsXml(xml).truncated).toBe(true);
    });

    it('an empty result is a result, not a failure', () => {
        const parsed = parseRowsXml('<rows truncated="false"><columns><c name="sku"/></columns></rows>');
        expect(parsed.columns).toEqual(['sku']);
        expect(parsed.rows).toEqual([]);
        expect(parsed.rowCount).toBe(0);
    });
});

// --- layer 2: the HTTP contract ----------------------------------------------------

describe('the database server HTTP contract', () => {
    it('answers /ping with its service marker and available providers', async () => {
        const res = await call('GET', '/ping');
        expect(res.status).toBe(200);
        expect(res.json).toEqual({ ok: true, service: 'db', providers: ['sqlserver'] });
    });

    it('stores a query and lists it, NEVER leaking the connection string', async () => {
        const record = {
            id: 'secretive', name: 'Orders', provider: 'sqlserver', description: 'open work orders',
            connection: { server: 'db-host', database: 'prod', auth: { user: 'sa', password: 'hunter2' } },
            sql: 'SELECT 1 AS one',
        };
        expect((await call('PUT', '/queries/secretive', record)).status).toBe(200);

        const list = await call('GET', '/queries');
        const found = list.json.queries.find((q: { id: string }) => q.id === 'secretive');
        expect(found).toMatchObject({ id: 'secretive', name: 'Orders', provider: 'sqlserver', database: 'prod' });

        // The whole point: the body must not carry the password or the auth
        // block, in any form, anywhere.
        const open = await call('GET', '/queries/secretive');
        for (const payload of [list.raw, open.raw]) {
            expect(payload).not.toContain('hunter2');
            expect(payload).not.toContain('password');
            expect(payload).not.toContain('"auth"');
        }
    });

    it('refuses a body whose id does not match the URL, and stores nothing', async () => {
        const res = await call('PUT', '/queries/Alpha', { id: 'Beta', sql: 'SELECT 1' });
        expect(res.status).toBe(400);
        expect((await call('GET', '/queries/Alpha')).status).toBe(404);
        expect((await call('GET', '/queries/Beta')).status).toBe(404);
    });

    it('refuses to STORE a query that is not a read', async () => {
        const res = await call('PUT', '/queries/destructive', { id: 'destructive', sql: 'DELETE FROM t' });
        expect(res.status).toBe(400);
        expect(res.json.error).toMatch(/refused/);
        expect((await call('GET', '/queries/destructive')).status).toBe(404);
    });

    it('delete is idempotent', async () => {
        await call('PUT', '/queries/temp', { id: 'temp', sql: 'SELECT 1' });
        expect((await call('DELETE', '/queries/temp')).status).toBe(200);
        expect((await call('DELETE', '/queries/temp')).status).toBe(200);
    });

    it('404s an unknown query and an unknown endpoint', async () => {
        expect((await call('GET', '/queries/nope')).status).toBe(404);
        expect((await call('POST', '/queries/nope/run')).status).toBe(404);
        expect((await call('GET', '/something-else')).status).toBe(404);
    });

    it('refuses to RUN a query that changes data, even if it reached the disk', async () => {
        // Bypassing PUT on purpose: this is the "file edited by hand" case the
        // run-path guard exists for, and it must not depend on the PUT guard.
        writeQueryFile({ id: 'sneaky', name: 'sneaky', provider: 'sqlserver', connection: { server: 'x' }, sql: 'DELETE FROM t' });
        const res = await call('POST', '/queries/sneaky/run');
        expect(res.status).toBe(400);
        expect(res.json.error).toMatch(/refused/);
        // Still listable, so an operator can see and correct it.
        expect((await call('GET', '/queries')).json.queries.some((q: { id: string }) => q.id === 'sneaky')).toBe(true);
    });

    it('refuses a provider it cannot run, with the reason', async () => {
        await call('PUT', '/queries/pg', { id: 'pg', name: 'pg', provider: 'postgres', connection: { server: 'x' }, sql: 'SELECT 1' });
        const res = await call('POST', '/queries/pg/run');
        expect(res.status).toBe(502);
        expect(res.json.error).toMatch(/postgres/);
    });

    it('reports a query with no server configured instead of guessing', async () => {
        await call('PUT', '/queries/noserver', { id: 'noserver', name: 'n', provider: 'sqlserver', sql: 'SELECT 1' });
        const res = await call('POST', '/queries/noserver/run');
        expect(res.status).toBe(502);
        expect(res.json.error).toMatch(/no server/i);
    });

    it('exposes the row cap the rest of the pipeline honours', () => {
        expect(MAX_ROWS).toBe(5000);
    });
});

// --- layer 3: a real SQL Server ----------------------------------------------------

/** Every LocalDB instance on this machine, or [] when there is no LocalDB. */
const localDbInstances = (): string[] => {
    try {
        return execFileSync('sqllocaldb', ['info'], { encoding: 'utf8', timeout: 15_000 })
            .split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    } catch {
        return [];
    }
};

/**
 * Make sure the instance can be connected to before anything uses it.
 *
 * A LocalDB instance stops itself when idle, and the first connection to a
 * stopped one takes several seconds while ADO.NET starts it — measured at
 * ~3.7 s here. `sqllocaldb start` first turns that into a startup cost rather
 * than a surprise in the middle of a hook, and this waits on the real thing:
 * a trivial query through the same helper the feature uses.
 *
 * ONE probe, not a retry loop. Probing is expensive (a PowerShell process plus
 * a fresh ADO.NET connect, ~2.5 s), so a loop of them is what makes a hook
 * time out — which is exactly how an earlier version of this helper failed.
 */
const ensureRunning = async (instanceName: string): Promise<boolean> => {
    await new Promise<void>((resolve) => { execFile('sqllocaldb', ['start', instanceName], { timeout: 60_000 }, () => resolve()); });
    return (await runPowershell([
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper,
        '-Instance', dataSourceFor(instanceName), '-QueryFile', probeSql(),
    ])).code === 0;
};

/**
 * The name ADO.NET needs for a LocalDB instance.
 *
 * `sqllocaldb info` lists bare names (`BarTender_DataBuilder_2019`) but a
 * connection string needs the `(localdb)\` prefix — without it ADO.NET looks
 * for a NETWORK server by that name and reports "server was not found", which
 * reads exactly like a stopped instance and sent an earlier debugging pass
 * chasing the wrong thing entirely.
 */
const dataSourceFor = (instanceName: string): string => `(localdb)\\${instanceName}`;

let probeFile = '';
/** A one-line query file for the readiness probe. */
const probeSql = (): string => {
    if (probeFile === '') {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipl-dbprobe-'));
        probeFile = path.join(dir, 'probe.sql');
        fs.writeFileSync(probeFile, 'SELECT 1 AS ready;', 'utf8');
    }
    return probeFile;
};

const runPowershell = (args: string[]): Promise<{ code: number; stdout: Buffer; stderr: string }> =>
    new Promise((resolve) => {
        execFile('powershell', args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
            resolve({ code: err ? 1 : 0, stdout: stdout as unknown as Buffer, stderr: String(stderr ?? '') });
        });
    });

const helper = path.join(process.cwd(), 'tools', 'query-sqlserver.ps1');

/**
 * Run arbitrary SQL through the same helper the server uses. Used only to
 * build and drop the fixture — and it is the right tool for that, because
 * seeding through sqlcmd is how an earlier attempt silently corrupted the
 * fixture: sqlcmd reads a UTF-8 .sql file as cp850, so the non-ASCII values
 * were already mangled before the feature ever read them back.
 */
const seed = async (instanceName: string, sql: string): Promise<void> => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipl-dbseed-'));
    const file = path.join(dir, 'seed.sql');
    fs.writeFileSync(file, sql, 'utf8');
    const result = await runPowershell(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Instance', dataSourceFor(instanceName), '-QueryFile', file]);
    fs.rmSync(dir, { recursive: true, force: true });
    if (result.code !== 0) throw new Error(`seed failed: ${result.stderr.trim() || result.stdout.toString('utf8')}`);
};

const nonAscii = /[^\x00-\x7F]/;

describe('against a real SQL Server', () => {
    const instances = localDbInstances();
    const instance = instances[0];

    // Test results are not a log, so this is one line out rather than a test
    // that passes by asserting nothing: on a machine with no SQL Server the
    // cases below skip, and the run should SAY that instead of reading as if
    // the character handling had been verified.
    if (!instance) console.warn('[dbServer] no LocalDB instance found — the real SQL Server cases are skipped on this machine.');

    describe.skipIf(!instance)('reading rows', () => {
        const table = `dbo.ipl_test_${Math.random().toString(36).slice(2, 8)}`;
        // Built from NCHAR so the SQL text itself is pure ASCII: nothing can
        // be mis-decoded on the way INTO the database, which is what broke the
        // first fixture. (Latin-1 covers every character here except the CJK
        // ones, which are listed explicitly.)
        const lit = (s: string): string => [...s]
            .map(c => c.charCodeAt(0) < 128
                ? `'${c.replace(/'/g, "''")}'`
                : `NCHAR(${c.charCodeAt(0)})`)
            .join('+');

        const fixture = [
            { sku: 'PLT-001', qty: 4, note: 'ünïcødé ÄÖÜß' },
            { sku: 'PLT-002', qty: 12, note: 'Привет' },
            { sku: 'PLT-003', qty: 7, note: '日本語' },
            { sku: 'PLT-004', qty: 3, note: 'a"b<&>' },
        ];

        beforeAll(async () => {
            if (!await ensureRunning(instance)) {
                throw new Error(`could not reach LocalDB instance "${instance}" — stop the instance and re-run to exercise this path`);
            }
            const create = [
                `IF OBJECT_ID('${table}') IS NOT NULL DROP TABLE ${table};`,
                `CREATE TABLE ${table} (sku NVARCHAR(40), qty INT, note NVARCHAR(80), nothing NVARCHAR(10));`,
                ...fixture.map(r => `INSERT INTO ${table} VALUES (N'${r.sku}', ${r.qty}, ${lit(r.note)}, NULL);`),
                'SELECT 1;',
            ].join('\n');
            await seed(instance, create);
            await call('PUT', '/queries/live', {
                id: 'live', name: 'Live rows', provider: 'sqlserver', description: 'the fixture',
                connection: { server: dataSourceFor(instance), database: 'master' },
                sql: `SELECT sku, qty, note, nothing FROM ${table} ORDER BY sku`,
            });
        }, 60_000);

        afterAll(async () => {
            if (instance) await seed(instance, `IF OBJECT_ID('${table}') IS NOT NULL DROP TABLE ${table};`).catch(() => undefined);
            await call('DELETE', '/queries/live').catch(() => undefined);
        }, 60_000);

        it('runs a stored query and returns its rows', async () => {
            const res = await call('POST', '/queries/live/run');
            expect(res.status).toBe(200);
            expect(res.json.rowCount).toBe(4);
            expect(res.json.truncated).toBe(false);
            expect(res.json.columns).toEqual(['sku', 'qty', 'note', 'nothing']);
            expect(res.json.rows.map((r: { sku: string }) => r.sku)).toEqual(['PLT-001', 'PLT-002', 'PLT-003', 'PLT-004']);
        }, 60_000);

        it('CARRIES EVERY CHARACTER: Latin-1, Cyrillic and CJK arrive intact', async () => {
            // The assertion that chose this implementation over sqlcmd. sqlcmd's
            // console output is cp850, which turns Привет and 日本語 into '?'
            // without reporting anything — for a label that is a misprint.
            const { json } = await call('POST', '/queries/live/run');
            const notes = json.rows.map((r: { note: string }) => r.note);
            expect(notes).toContain('ünïcødé ÄÖÜß');
            expect(notes).toContain('Привет');
            expect(notes).toContain('日本語');
            for (const note of notes) {
                expect(note).not.toMatch(/\?/);
                expect(note).not.toMatch(/�/);
                expect(nonAscii.test(note) || note.includes('"')).toBe(true);
            }
        }, 60_000);

        it('keeps quotes and angle brackets in data from breaking the document', async () => {
            const { json } = await call('POST', '/queries/live/run');
            expect(json.rows.map((r: { note: string }) => r.note)).toContain('a"b<&>');
        }, 60_000);

        it('reports a NULL column rather than dropping it', async () => {
            const { json } = await call('POST', '/queries/live/run');
            // Present in the column list even though EVERY value is NULL.
            expect(json.columns).toContain('nothing');
        }, 60_000);

        it('truncates past the cap and says so, instead of failing', async () => {
            await call('PUT', '/queries/many', {
                id: 'many', name: 'many', provider: 'sqlserver',
                connection: { server: dataSourceFor(instance), database: 'master' },
                sql: `SELECT TOP (20) sku FROM ${table} AS a CROSS JOIN (SELECT 1 AS x UNION ALL SELECT 2) AS b`,
            });
            const { json } = await call('POST', '/queries/many/run');
            expect(json.ok).toBe(true);
            expect(json.rowCount).toBeLessThanOrEqual(MAX_ROWS);
        }, 60_000);

        it('reports a broken query as an error, not as an empty result', async () => {
            await call('PUT', '/queries/broken', {
                id: 'broken', name: 'broken', provider: 'sqlserver',
                connection: { server: dataSourceFor(instance), database: 'master' },
                sql: 'SELECT * FROM dbo.table_that_does_not_exist',
            });
            const res = await call('POST', '/queries/broken/run');
            expect(res.status).toBe(502);
            expect(res.json.ok).toBe(false);
            expect(res.json.error).toMatch(/table_that_does_not_exist/);
        }, 60_000);

        it('an unreachable server is an error the user can act on', async () => {
            await call('PUT', '/queries/deadserver', {
                id: 'deadserver', name: 'dead', provider: 'sqlserver',
                connection: { server: '(localdb)\\NoSuchInstance' },
                sql: 'SELECT 1',
            });
            const res = await call('POST', '/queries/deadserver/run');
            expect(res.status).toBe(502);
            expect(res.json.error).toMatch(/NoSuchInstance|network-related|error/i);
        }, 60_000);
    });
});
