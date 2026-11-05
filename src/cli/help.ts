export const COMMANDS = [
  { cmd: 'init [dir] [--write] [--force]', desc: 'Detect services (Node, Python, Go, Java, Rust, .NET, Docker Compose, Procfile) and draft devpilot.yaml; --write saves and registers it' },
  { cmd: 'up [profile|service...] [--wait]', desc: 'Start a profile (default: "default") or services, dependencies first' },
  { cmd: 'down [service...]', desc: 'Stop the workspace (dependents first) or the given services' },
  { cmd: 'start|stop|restart <service> [--wait] [--timeout 60s] [--no-deps]', desc: 'Control one service; --wait blocks until ready and returns logs on failure' },
  { cmd: 'status [service] [--all]', desc: 'Status, health, CPU/mem, restarts of the current workspace (or one service)' },
  { cmd: 'logs <service> [-n 100] [--grep re] [--since 5m] [--stream err|out|sys] [-f]', desc: 'Query or follow logs' },
  { cmd: 'incidents [service] [--open] [--since 1h] [--all] | incidents clear [service] [--all]', desc: 'Crashes, failed starts, health failures, memory alarms, error bursts; clear marks them resolved' },
  { cmd: 'diagnose <service>', desc: 'Triage report: verdict, findings with suggestions, error block, deps, port holder, missing env' },
  { cmd: 'metrics <service> [--range 15m|1h|24h]', desc: 'CPU / memory / health-latency history' },
  { cmd: 'env [service] [--reveal] | env use <profile> [--restart]', desc: 'Show resolved env, or switch the workspace env profile' },
  { cmd: 'ports [--all] | ports kill <port> --force', desc: 'Who listens where; kill a port holder (explicit --force only)' },
  { cmd: 'open [service]', desc: 'Open the web dashboard (one-time login link)' },
  { cmd: 'watch [--all]', desc: 'Stream incidents / recoveries as single lines (used by the Claude monitor)' },
  { cmd: 'register [dir] | unregister [workspace]', desc: 'Add/remove a workspace (unregister stops its services)' },
  { cmd: 'daemon start|stop|restart|status [--keep-services]', desc: 'Manage the background daemon' },
  { cmd: 'import-jsrunner [--from projects.json] [--write]', desc: 'Convert jsrunner projects/profiles into DevPilot workspaces' },
  { cmd: 'help [config]', desc: 'This help, or the devpilot.yaml reference' },
];

export const HELP = `devpilot — run and monitor local dev services

Usage: devpilot <command> [options]     (every command accepts --json)

${COMMANDS.map((c) => `  ${c.cmd}\n      ${c.desc}`).join('\n')}

Services are referenced by name ("api") within the current folder's workspace,
or as "<workspace>/<service>". Global flags: --ws <workspace>, --json.
State: ~/.devpilot (override with DEVPILOT_HOME).`;

export const CONFIG_HELP = `devpilot.yaml reference

version: 1
name: my-app                       # optional display name
env_files: [.env]                  # loaded for every service (relative to this file)
env: { TZ: UTC }                   # extra vars for every service
env_profiles:                      # switch with: devpilot env use staging --restart
  staging: { env_files: [.env.staging], env: { API_URL: https://staging.example.com } }
profiles:                          # devpilot up <profile>; "default" = all services if omitted
  default: [db, api, web]
  backend: [db, api]
services:
  db:
    compose: docker-compose.yml    # runs: docker compose -f <file> up <services...>
    services: [postgres, redis]    # stop runs: docker compose -f <file> stop <services...>
    health: { tcp: 5432 }
  api:
    cwd: backend                   # relative to this file
    run: npm run start:dev         # any shell command: python -m uvicorn main:app --port $PORT, go run ., mvnw spring-boot:run
    port: 3000                     # exported as PORT; checked for conflicts before start
    url: http://localhost:3000     # optional; defaults to http://localhost:<port>
    env: { NODE_ENV: development }
    env_files: [.env.local]        # relative to cwd
    depends_on: [db]               # started first and waited until ready
    health:                        # readiness + ongoing health
      http: /health                # path on the service port, or a full URL; or tcp: <port>
      expect: 200                  # or a list; default: any status < 500
      interval: 5s
      timeout: 2s
    ready: { log: "Nest application successfully started", timeout: 120s }  # readiness by log line (regex)
    restart: { policy: on-failure, max: 5, backoff: exponential, delay: 1s, window: 2m }   # policy: no | on-failure | always
    stop: { command: "", timeout: 5s }   # optional graceful stop command, then the process tree is killed
    alerts: { mem_mb: 1500, unhealthy_after: 3, error_patterns: ["DEADLOCK"] }
    autostart: false               # start when the daemon boots
    group: Core services           # optional heading in the panel (default: derived from depends_on)

Readiness: ready.log if set, else the health check, else "alive for 1.5s".
Without health config a service with a port gets a TCP check on that port (IPv4 and IPv6).`;
