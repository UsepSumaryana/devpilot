# DevPilot

Plugin Claude Code untuk **menjalankan dan memonitor service lokal** — API, frontend, worker, dan database
lewat Docker Compose, runtime apa pun — dari satu tempat: CLI, web dashboard, dan panel di samping chat
Claude desktop. Penerus jsrunner yang lebih lengkap.

- **Daemon supervisor** per user (`devpilotd`): service tetap jalan walau sesi Claude atau terminal ditutup,
  dan tetap terpantau walau daemon sendiri di-restart (output service ditulis ke file lalu di-tail, bukan lewat pipe).
- **Multi-runtime**: Node (npm/yarn/pnpm/bun), Python (Django/FastAPI/Flask), Go, Java (Maven/Gradle/Spring Boot),
  Rust, .NET, Docker Compose, Procfile, atau perintah bebas. `devpilot init` mendeteksinya otomatis.
- **Monitoring**: health check HTTP/TCP (IPv4 + IPv6) dengan latency, readiness via pola log,
  CPU/RAM per process tree dengan histori 1 jam / 24 jam, restart policy dengan exponential backoff,
  deteksi error di log (stack trace digabung jadi satu incident, error berulang dilipat),
  alarm memori, dan deteksi konflik port.
- **Dependency & env**: `depends_on` menunggu readiness (service yang menunggu tampil sebagai *queued*),
  profile service, dan env profile (`.env.staging`, …).
- **Integrasi Claude lewat CLI**: semua perintah `devpilot … --json`; skill untuk setup, diagnose, up/status/logs;
  hook SessionStart memberi Claude ringkasan status; *monitor* mengirim notifikasi crash ke sesi.
  Claude menawarkan diagnosis dan **tidak** mengubah kode tanpa diminta.
- **Web dashboard** (`devpilot open`): overview, graf dependency, grafik CPU/RAM/latency, log live, incident,
  diagnose, env, dan port map.
- **Panel Services di Claude desktop** (plugin `devpilot-panel`): health bar, kartu incident dengan
  *Ask Claude* dan *Logs*, layer Infra / Core services / BFF / Frontend, serta Start/Stop per service.

```
Claude ──Bash──► devpilot CLI ─┐
Monitor (devpilot watch) ──────┤
Panel mod ($.http.fetch) ──────┼──HTTP 127.0.0.1 + token──► devpilotd ──► service (file stdout/stderr)
Dashboard (browser, SSE) ──────┘
```

## Instalasi

Butuh Node.js ≥ 20. `plugins/devpilot/dist/` sudah ter-build di repo, jadi plugin jalan tanpa `npm install`.

```bash
claude plugin marketplace add UsepSumaryana/devpilot
```

```bash
claude plugin install devpilot@devpilot
```

```bash
claude plugin install devpilot-panel@devpilot
```

Dari clone lokal: `claude plugin marketplace add <path-ke-clone>`. Untuk mencoba satu sesi saja tanpa install:
`claude --plugin-dir plugins/devpilot --plugin-dir plugins/devpilot-panel`.

Agar Claude tidak meminta izin di setiap perintah DevPilot, tambahkan `Bash(devpilot:*)` ke `permissions.allow`
di settings Claude Anda (opsional).

Di luar Claude, CLI bisa dipakai langsung: `node plugins/devpilot/dist/cli.js`, atau jalankan `npm link`
di clone repo ini supaya perintah `devpilot` tersedia di PATH.

## Update

**Dipasang dari GitHub** (`marketplace add UsepSumaryana/devpilot`):

```bash
claude plugin marketplace update devpilot
```

```bash
claude plugin update devpilot@devpilot
```

```bash
claude plugin update devpilot-panel@devpilot
```

Lalu, di sesi Claude yang sedang terbuka, jalankan `/reload-plugins` atau buka sesi baru.

**Dipasang dari clone lokal** (`marketplace add <path-ke-clone>`): plugin dibaca langsung dari folder,
jadi cukup `git pull` di clone, lalu `/reload-plugins`. `plugin update` tidak perlu.

**Setelah update, restart daemon** supaya daemon memakai kode baru. Service yang sedang jalan tetap hidup
dan di-adopsi ulang:

```bash
devpilot daemon restart
```

Dashboard yang sedang terbuka perlu di-refresh penuh (Ctrl+F5); login 30 hari tetap berlaku.

Cek versi yang terpasang: `claude plugin list` (plugin), `devpilot version` (CLI), dan `devpilot daemon status`
(daemon yang sedang berjalan). Kalau versi daemon lebih lama dari CLI, berarti daemon belum di-restart.

## Mulai cepat

Di folder proyek:

```bash
devpilot init            # deteksi service, tampilkan draf devpilot.yaml
devpilot init --write    # simpan + daftarkan workspace
devpilot up --wait       # jalankan profile "default", dependency lebih dulu
devpilot status
devpilot open            # dashboard
```

Atau minta Claude: *"set up devpilot untuk project ini lalu jalankan"*.

## Panel Services (Claude desktop)

Panel terbuka sendiri saat sesi dimulai. Kalau ditutup, buka lagi dengan **`/devpilot-panel`**
(atau `/dp-services`, atau `/services` bila namanya tidak bentrok dengan perintah bawaan). Isinya:

- **Header**: nama workspace, status aksi yang sedang berjalan, ⊞ untuk dashboard, ⋯ untuk menu
  (semua proyek, rangkum incident lewat Claude, clear incident).
- **Health bar**: "N of M up" plus satu segmen per service (hijau jalan, biru starting, merah gagal).
- **Kartu incident** untuk service yang crash/unhealthy: kode keluar, jumlah restart, berapa service yang tertahan,
  tombol ✦ *Ask Claude* (Claude mendiagnosis tanpa mengubah apa pun), ≡ *Logs*, dan ■.
- **Layer**: service dikelompokkan menurut tier dependency (Infra → Core services → BFF → Frontend), atau menurut
  `group:` di `devpilot.yaml`. Tiap baris punya tombol ▶ / ■ / ↻, dan ✕ untuk mengeluarkan service *queued* dari antrean.
- **Footer**: *Start all* dan *Stop all*.

Setelah memperbarui plugin, jalankan `/reload-plugins`.

## devpilot.yaml

```yaml
version: 1
env_files: [.env]
env_profiles:
  staging: { env_files: [.env.staging] }
profiles:
  default: [db, api, web]
services:
  db:
    compose: docker-compose.yml
    services: [postgres]
    health: { tcp: 5432 }
  api:
    cwd: backend
    run: npm run start:dev
    port: 3000
    depends_on: [db]
    health: { http: /health }
    restart: { policy: on-failure, max: 5, backoff: exponential }
    alerts: { mem_mb: 1500 }
  web:
    cwd: frontend
    run: npm run dev
    port: 5173
    depends_on: [api]
    group: Frontend          # opsional: judul kelompok di panel
```

Referensi lengkap: `devpilot help config`.

### Mode dan task

**Task** adalah perintah sekali jalan, misalnya `yarn install`, build, atau migrasi. **Mode** adalah cara lain menjalankan
sebuah service, misalnya watch atau hasil build. Field yang tidak diisi dalam mode memakai config biasa (mode `default`).

```yaml
tasks:                              # level workspace, cwd = folder devpilot.yaml
  install: yarn install
services:
  api:
    run: yarn start:dev             # mode default (watch)
    port: 3000
    tasks:
      build: yarn build
      clean-install: { run: yarn install --force, stop_service: true }   # service dihentikan sementara
    modes:
      build:
        run: node dist/main.js
        before: [install, build]    # dijalankan dulu saat start sengaja (bukan saat restart karena crash)
        env: { NODE_ENV: production }
```

```bash
devpilot task                       # daftar task + riwayat run
devpilot task run install           # task workspace, output diikuti sampai selesai
devpilot task run build api         # task milik service api
devpilot task run install --all     # di setiap service yang punya task install
devpilot mode use build --restart   # semua service yang punya mode build
devpilot start api --mode build     # satu service saja
devpilot mode reset --restart       # kembali ke mode default
```

Di panel, mode aktif tampil di samping nama service, dan menu ⋯ berisi pilihan **MODE** serta **TASKS**.
Di dashboard tersedia pilihan mode dan tombol task, baik di overview maupun di halaman service.
`devpilot init` otomatis menambahkan task `install`/`build`, dan mode `build` bila script proyek memungkinkan.

## Perintah

| Perintah | Fungsi |
|---|---|
| `devpilot up [profile\|service…] [--wait]` | Start (dependency dulu) |
| `devpilot down [service…]` | Stop (dependent dulu); service *queued* dikeluarkan dari antrean |
| `devpilot start\|stop\|restart <svc> [--wait]` | Kontrol satu service; kalau gagal, keluar alasan + log |
| `devpilot status [svc] [--all]` | Status, health, CPU/RAM, restart |
| `devpilot logs <svc> [-n] [--grep] [--since] [-f]` | Log |
| `devpilot incidents [svc] [--open]` | Crash, gagal start, unhealthy, memori, error log |
| `devpilot incidents clear [svc] [--all]` | Tandai incident selesai |
| `devpilot diagnose <svc>` | Laporan triage: verdict, temuan + saran, error block, pemegang port, env yang hilang |
| `devpilot metrics <svc> [--range]` | Histori CPU/RAM/latency |
| `devpilot env [svc] \| env use <profile> [--restart]` | Env yang dipakai / ganti env profile |
| `devpilot mode \| mode use <mode> [svc…] [--restart] \| mode reset` | Lihat / ganti mode (watch, build, prod…) |
| `devpilot task \| task run <task> [svc] [--all] [--detach] \| task cancel <id>` | Jalankan task sekali jalan (install, build, migrasi) |
| `devpilot ports [--all] \| ports kill <port> --force` | Siapa memakai port mana |
| `devpilot open [svc]` | Dashboard (link login sekali pakai) |
| `devpilot watch` | Stream incident (dipakai monitor Claude) |
| `devpilot daemon start\|stop\|restart\|status` | Kelola daemon (`restart` mempertahankan service) |
| `devpilot import-jsrunner [--from …] [--write]` | Migrasi dari jsrunner ke `~/.devpilot/imported/` (repo tidak disentuh) |

Semua perintah menerima `--json`.

## Keamanan

Daemon hanya bind ke `127.0.0.1`. Setiap request `/api` butuh token (`~/.devpilot/daemon.json`) atau cookie
dashboard yang didapat lewat link sekali pakai dari `devpilot open`. Guard Host/Origin/Sec-Fetch-Site menahan
DNS rebinding dan CSRF. `ports kill` untuk proses yang bukan milik DevPilot wajib `--force`.

## Pengembangan

```bash
npm install
npm run build        # bundle ke plugins/devpilot/dist (di-commit)
npm run check        # typecheck + boundary guard + vitest
npm run test:panel   # test panel mod (claude plugin test)
npm run validate     # claude plugin validate
```

Struktur:

- `src/core`: supervisor, config, health, metrics, logs, incidents, detect, diagnose, dan `platform/` — satu-satunya
  tempat primitif OS, dijaga `scripts/check-boundary.mjs`.
- `src/daemon`: API Hono + SSE.
- `src/cli`, `src/hooks` (SessionStart), `src/dashboard` (Preact + uPlot).
- `plugins/devpilot`: plugin (bin, skills, hook, monitor, dist).
- `plugins/devpilot-panel`: mod panel desktop.

State disimpan di `~/.devpilot` (ubah dengan `DEVPILOT_HOME`); port daemon default 47800 (`DEVPILOT_PORT`).

### Catatan Windows

Proses konsol di Windows tidak bisa diminta berhenti dengan sopan, jadi `stop` langsung mematikan process tree
(`taskkill /T /F`), kecuali service mendefinisikan `stop.command` (Compose otomatis memakai `docker compose stop`).

## Lisensi

MIT
