# Shared helpers for the integration scripts (sourced, not run).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
export FANOUT_HOME="$WORK/home"

fanout() { node "$ROOT/src/cli.ts" "$@"; }
step() { printf '\n== %s\n' "$*"; }
fail() {
  printf '✗ %s\n' "$1" >&2
  [ $# -gt 1 ] && printf '%s\n' "$2" >&2
  exit 1
}
# expect <text> <output>: the output must contain the text.
expect() { grep -qF -- "$1" <<<"$2" || fail "expected \"$1\"" "$2"; }
# reject <text> <output>: the output must not contain the text.
reject() { ! grep -qF -- "$1" <<<"$2" || fail "did not expect \"$1\"" "$2"; }
# json <expression>: evaluate a JS expression over stdin parsed as JSON (bound to `d`).
json() { node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const d=JSON.parse(s);console.log(eval(process.argv[1]))})" "$1"; }
# run <command…>: a fanout command whose output is checked next; on failure show what it said.
# (Under set -e, `out=$(fanout …)` would otherwise exit silently before the checks run.)
run() {
  local out
  out=$(fanout "$@" 2>&1) || fail "fanout $1 failed" "$out"
  printf '%s' "$out"
}
# until_ok <seconds> <command…>: retry a command until it succeeds.
until_ok() {
  local deadline=$((SECONDS + $1))
  shift
  until "$@" >/dev/null 2>&1; do
    [ $SECONDS -lt $deadline ] || fail "timed out: $*"
    sleep 1
  done
}
# wait_for <url> <seconds>: until the URL answers 200.
wait_for() {
  local deadline=$((SECONDS + $2))
  until [ "$(curl -s -o /dev/null -w '%{http_code}' "$1" || true)" = 200 ]; do
    [ $SECONDS -lt $deadline ] || fail "timed out waiting for $1"
    sleep 3
  done
}

# Test media: a short vertical clip, a thumbnail and a Korean caption.
make_media() {
  ffmpeg -loglevel error -y -f lavfi -i "testsrc2=size=720x1280:rate=30:duration=4" -f lavfi -i "sine=frequency=440:duration=4" \
    -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$WORK/clip.mp4"
  ffmpeg -loglevel error -y -f lavfi -i "testsrc=size=640x360:rate=1" -frames:v 1 "$WORK/thumb.jpg"
  printf 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n안녕하세요\n' >"$WORK/ko.vtt"
}

# post_id <output of fanout post>: the short id it printed.
post_id() { sed -n 's/^post \([0-9a-f]*\) 생성$/\1/p' <<<"$1"; }
