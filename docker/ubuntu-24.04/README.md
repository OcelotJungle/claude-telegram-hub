# Ubuntu 24.04 verification

Build and run the test image from the repository root:

```bash
docker build --target tests -t telegram-hub-tests -f docker/ubuntu-24.04/Dockerfile . && docker run --name telegram-hub-tests-run --cpus=1 telegram-hub-tests
docker cp telegram-hub-tests-run:/home/ubuntu/claude-telegram-hub/reports ./reports
docker inspect -f '{{.State.ExitCode}}' telegram-hub-tests-run
docker rm telegram-hub-tests-run
```

Allocate fewer CPUs than the host has. The suite runs serially and retains its complete
output in `reports/linux-typecheck.log` and `reports/linux-tests.log` inside the container.
The named container retains those files even when a check fails; copy them before removal.

The separate systemd image starts PID 1 for user-service validation:

```bash
docker build --target systemd -t telegram-hub-systemd -f docker/ubuntu-24.04/Dockerfile .
docker run --name telegram-hub-systemd --privileged --cgroupns=host --tmpfs /run --tmpfs /run/lock -v /sys/fs/cgroup:/sys/fs/cgroup:rw -d telegram-hub-systemd
docker exec telegram-hub-systemd systemctl start systemd-logind.service
docker exec telegram-hub-systemd loginctl enable-linger ubuntu
docker exec -u ubuntu -e TELEGRAM_HUB_CONTAINER_TEST=1 telegram-hub-systemd bash -lc 'cd ~/claude-telegram-hub && bash scripts/test-systemd.sh'
docker cp telegram-hub-systemd:/home/ubuntu/claude-telegram-hub/docs/reports/systemd-smoke.json ./systemd-smoke.json
docker rm -f telegram-hub-systemd
```

`check-hub-service.ts` drives a fake Bot API and a fake executable rig. It verifies the
installed unit/linger, kills the actual hub PID and waits for a new getMe after automatic
restart, starts tmux and a long-lived /bash through the hub, confirms Telegram disable,
and checks that rig finishes after stopping the service while tmux and bash remain alive.
`rig-service-process.ts` supplies the fake rig and child processes. API and file events
drive the checks; there are no sleeps. The wrapper's five-minute external deadline comes
from the rig readiness budget. All processes and temporary files have teardown handlers.
The scripts refuse host execution and require explicit container opt-in.

The claude target installs the real native CLI on the stable channel using the
[official installer](https://code.claude.com/docs/en/setup), without logging in:

```bash
docker build --target claude -t telegram-hub-claude -f docker/ubuntu-24.04/Dockerfile . && docker run --name telegram-hub-claude-run --cpus=1 telegram-hub-claude
docker cp telegram-hub-claude-run:/home/ubuntu/claude-telegram-hub/docs/reports ./claude-reports
docker rm telegram-hub-claude-run
```

`probe-claude-linux.ts` removes authentication variables, uses an isolated HOME/config
and tmux server, probes real CLI version/flags, captures its interactive startup and
inspects any real plugin socket and transcript it creates. `claude-probe-terminal.ts`
waits for the output pipe before starting Claude, so the first dialog is captured.
`claude-linux-probe.json`, `claude-help.log` and `claude-tmux.log` retain observations.
No model request, credential mount or login is performed. Unavailable mechanisms are
marked blocked by name: actual turn interruption with `!`, accepting/using the channel,
and socket/transcript artifacts that require an authenticated session. These go into
the separate joint rig end-to-end run; a blocked check is never reported as passed.
