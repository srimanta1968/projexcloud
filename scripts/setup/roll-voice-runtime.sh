#!/usr/bin/env bash
#
# Rolling update of the voice-runtime agent workers (VA·E1 · TK-4466) that never kills a
# worker carrying calls and never drops capacity:
#
#   1. start N new workers (new image) ALONGSIDE the N running ones;
#   2. wait until every new worker's /readyz is 200 (registered with LiveKit, taking calls);
#   3. SIGTERM the old workers with their restart policy switched off. Each one drains —
#      LiveKit stops offering it jobs at once; its live calls run to the end — and exits by
#      itself when the last call ends or VOICE_RUNTIME_DRAIN_TIMEOUT_MS (default 2 h) passes.
#      Nothing here waits on that, and nothing ever SIGKILLs them;
#   4. a detached reaper removes each old container once it has exited.
#
# A plain `docker compose up -d voice-runtime` would instead stop the old worker first and
# wait up to stop_grace_period (2 h) with NO worker taking new calls.
#
# Called by deploy-service.sh for the voice-runtime service; `compose` is the caller's
# main-stack compose function (same files + profiles as deploy.sh). Usage:
#   roll_voice_runtime            # after `compose build voice-runtime`
set -euo pipefail

roll_voice_runtime() {
  local svc=voice-runtime project=${VOICE_ROLL_PROJECT:-projexcloud-prod}
  local ready_timeout=${VOICE_ROLL_READY_TIMEOUT:-180}

  mapfile -t old < <(docker ps -q --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$svc")
  local n=${#old[@]}
  if [ "$n" -eq 0 ]; then
    echo "== no running $svc: starting it =="
    compose up -d --no-deps "$svc"
    return
  fi
  local want=${VOICE_RUNTIME_REPLICAS:-$n}

  echo "== starting $want new $svc worker(s) beside $n draining-to-be =="
  compose up -d --no-deps --no-recreate --scale "$svc=$((n + want))" "$svc"
  mapfile -t all < <(docker ps -q --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$svc")
  local fresh=()
  for c in "${all[@]}"; do
    [[ " ${old[*]} " == *" $c "* ]] || fresh+=("$c")
  done
  [ "${#fresh[@]}" -gt 0 ] || { echo "no new $svc container started; old workers left untouched" >&2; return 1; }

  echo "== waiting for ${#fresh[@]} new worker(s) to be ready =="
  local deadline=$((SECONDS + ready_timeout))
  for c in "${fresh[@]}"; do
    until docker exec "$c" node -e "fetch('http://127.0.0.1:'+(process.env.VOICE_RUNTIME_HEALTH_PORT||8081)+'/readyz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null; do
      if [ $SECONDS -ge $deadline ]; then
        echo "new worker $c not ready after ${ready_timeout}s — removing the new workers, old ones keep serving" >&2
        docker rm -f "${fresh[@]}" >/dev/null
        return 1
      fi
      sleep 2
    done
    echo "   ready: $c"
  done

  echo "== draining ${#old[@]} old worker(s) =="
  for c in "${old[@]}"; do
    # Exit 0 after a drain must not bring it back.
    docker update --restart=no "$c" >/dev/null
    docker kill --signal=SIGTERM "$c" >/dev/null
    echo "   draining: $c ($(docker exec "$c" node -e "fetch('http://127.0.0.1:'+(process.env.VOICE_RUNTIME_HEALTH_PORT||8081)+'/status').then(r=>r.json()).then(s=>console.log(s.active_calls+' live call(s)'),()=>console.log('status n/a'))" 2>/dev/null || echo 'exiting'))"
    # Reaper: remove it once the drain has ended on its own.
    nohup sh -c "docker wait '$c' >/dev/null 2>&1; docker rm '$c' >/dev/null 2>&1" >/dev/null 2>&1 &
  done
  echo "VOICE_RUNTIME_ROLLED"
}
