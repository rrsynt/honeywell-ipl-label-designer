# Shop Deploy Guide — running the designer + its servers in a warehouse/retail shop

The app itself is a static build (`npm run build` → `dist/`, serve with any
static host). The four `tools/*.mjs` servers are what connect it to printers,
a shared queue, a shared library and a database. This guide covers both ends:
a single station (zero config) and a shop LAN (token + allow-list).

## 1. The pieces and their defaults

| Server | Command | HTTP default | Does |
|---|---|---|---|
| Bridge | `node tools/ipl-bridge.mjs` | `127.0.0.1:9181` | Browser → raw TCP to a printer (`host:port`, default `localhost:9100`) |
| Library | `node tools/library-server.mjs` | `127.0.0.1:9182` | Shared designs/sources, `./library-data` |
| Print | `node tools/print-server.mjs` | `127.0.0.1:9183` | Shared queue + printer list + log, `./print-data` |
| DB | `node tools/db-server.mjs` | `127.0.0.1:9184` | Named SQL Server queries, `./db-data/queries` |

Defaults bind **localhost only**: nothing leaves the machine until you ask it
to. `/ping` and `/health` are public on every server (liveness + counts);
everything else follows the token rule below.

## 2. Single station (one PC, one printer)

No flags needed:

```bash
node tools/ipl-bridge.mjs            # forward mode
node tools/print-server.mjs          # only if you want a persistent queue/log
npm run dev                          # or serve dist/
```

In the app: printer target `localhost:9100` (Print Center → printer list),
bridge URL default `http://localhost:9181`. Leave every Token field empty —
a server started without `--token` accepts local callers as before.

To capture what BarTender/a driver sends (fake printer):

```bash
node tools/ipl-bridge.mjs --listen=9100   # then GET /capture, DELETE /capture
```

## 3. Shop LAN (one server PC, many stations)

Pick one always-on PC as the server host (example `192.168.1.10`). Generate
one token per server (they are independent) and keep them in the shop's
password manager — anyone holding a token can print, overwrite the library
and run stored queries:

```powershell
# PowerShell: 32 random chars per server
([Convert]::ToBase64String((1..24 | ForEach-Object { Get-Random -Max 256 })))
```

Start the servers on the host (example tokens — use your own):

```bash
node tools/print-server.mjs --host=0.0.0.0 --token=<PRINT> --dir=D:/shared/print-data
node tools/library-server.mjs --host=0.0.0.0 --token=<LIB> --dir=D:/shared/library-data
node tools/db-server.mjs --host=0.0.0.0 --token=<DB>
node tools/ipl-bridge.mjs --host=0.0.0.0 --token=<BRIDGE> --allow=192.168.1.20:9100,192.168.1.21:9100
```

Rules that bite if skipped:

- `--host=0.0.0.0` is REQUIRED for LAN — without it the server answers only
  itself, and stations get "unreachable" with nothing in the log.
- `--allow` on the bridge lists the PRINTERS it may forward to
  (`host` or `host:port`, repeatable/comma-separated, default localhost only).
  A bridge without `--allow` refuses every non-local printer with 403 — that
  is the SSRF guard, not a bug.
- `--dir` must be a folder every station's data can live in; **never run two
  print-servers on the same `--dir`** — the second exits 1 (`already holds`)
  instead of double-printing your queue. A stale `server.lock` after a crash
  is reclaimed automatically with a log line.
- `PUT /queries/:id` (storing a query = storing credentials + SQL) is
  accepted **from the server machine only**, token or not. Administer queries
  with files or `curl` on the host; stations list and run.
- Open the four ports (9181–9184 or your `--port`s) in Windows Firewall on
  the host, scoped to the LAN subnet — not to the internet. None of these
  servers is an internet service (no TLS, no rate limiting, one shared token).

Environment equivalents (for services/scheduled tasks): `IPL_PRINT_HOST`,
`IPL_PRINT_TOKEN`, `IPL_PRINT_DIR`, and the same `IPL_LIBRARY_*`,
`IPL_DB_*`, `IPL_BRIDGE_*` (+ `IPL_BRIDGE_ALLOW`) pattern.

## 4. Wiring the stations

In the app, per station:

1. Print Center → server row: `http://192.168.1.10:9183` + Token `<PRINT>`
   → "Use server". The queue, printer list and log are now shared.
2. Designs screen → server row: `http://192.168.1.10:9182` + Token `<LIB>`.
3. Data tab → database row: `http://192.168.1.10:9184` + Token `<DB>`,
   then pick a stored query (stations can never write queries or see
   passwords — list/run only).
4. Direct printing without the queue still goes through a bridge: either keep
   each station's local bridge (default, no token) or point the station at a
   shared one — with its token and an `--allow` covering that station's
   printer.

A 401 in the UI always means wrong/missing token ("enter the same token the
server was started with"), never a dead server. Check `/health` first when
something is off:

```bash
curl http://192.168.1.10:9183/health
# {"ok":true,"service":"print","uptimeSec":86400,"jobs":12,"pending":2}
```

`/health` answers on all four servers (bridge adds `mode`, library `designs`,
db `queries`). Mutations and every 4xx/5xx are one log line on the host
(who/what/where; row counts, never row contents or credentials).

## 5. Database queries (admin, on the host)

Query files live in `<db-data>/queries/*.json`:

```json
{
  "id": "lots-today",
  "name": "Today's lots",
  "provider": "sqlserver",
  "connection": { "server": "DBHOST", "database": "shop", "auth": "integrated" },
  "sql": "SELECT lot, qty FROM lots WHERE printed = 0",
  "description": "Unprinted lots, oldest first"
}
```

- `auth`: `"integrated"` (Windows auth, preferred — no password on disk) or
  `{ "user": "...", "password": "..." }` (lands in the file + the helper's
  command line; prefer a dedicated least-privilege SQL login).
- Only a single `SELECT`/`WITH` is accepted (read-only guard); anything else
  is refused at PUT and at run time.
- Prefer hand-editing the files over `PUT` from a remote machine — PUT is
  loopback-only by design. After editing, `GET /queries` (no credentials in
  any answer) confirms the list.
- TLS to SQL Server: the helper currently trusts the server certificate
  (`TrustServerCertificate`, `tools/query-sqlserver.ps1`). On an untrusted
  LAN install a proper cert or pin the thumbprint — otherwise a MITM sees
  credentials and label rows.

## 6. Backup

Back up the three data dirs (`print-data`, `library-data`, `db-data`) —
they ARE the shop's queue, designs and credentials. The `dist/` build and the
repo need no backup beyond git (`main` on origin holds every change).

## 7. Troubleshooting

| Symptom | Check |
|---|---|
| Station: "unreachable" | Server running? host `:918x` reachable (`/ping`)? firewall? `--host=0.0.0.0` on the host? |
| 401 everywhere | Token mismatch — compare the UI field with the server's `--token` |
| Bridge 403 `not on the allow list` | Add the printer to `--allow`, restart the bridge |
| Second print-server exits 1 `already holds` | Another process owns that `--dir` — use a different dir, don't force it |
| Job prints twice after retry | Expected on the DIRECT bridge path (bytes may have flushed before the failure); the print-server path never warns because its `accepted` count is exact — prefer it for big jobs |
| Cancelled job still finishes its chunk | By design: bytes on the wire can't be recalled; nothing AFTER the in-flight chunk prints |
| `PUT /queries` 403 from a station | By design: store queries on the host (files or localhost curl) |
