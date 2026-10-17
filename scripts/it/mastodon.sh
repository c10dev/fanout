#!/usr/bin/env bash
# End-to-end check of the Mastodon provider against a throwaway Mastodon (web + sidekiq) in Docker:
# connect, doctor --live, post with thumbnail, edit, comments, reply (mention + Idempotency-Key),
# stats, schedule and its cancellation, remove. Needs docker, node 24, ffmpeg, curl and openssl.
#   scripts/it/mastodon.sh            (MD_IMAGE, MD_PORT to override)
source "$(dirname "$0")/lib.sh"

N=fanout-it-mastodon
PORT="${MD_PORT:-3310}"
PROXY_PORT=$((PORT + 1))
IMAGE="${MD_IMAGE:-ghcr.io/mastodon/mastodon:v4.7.3}"
BASE="http://localhost:$PROXY_PORT"
PROXY_PID=
cleanup() {
  [ -n "$PROXY_PID" ] && kill "$PROXY_PID" 2>/dev/null || true
  docker rm -f "$N-web" "$N-sidekiq" "$N-pg" "$N-redis" >/dev/null 2>&1 || true
  docker network rm "$N" >/dev/null 2>&1 || true
  docker volume rm "$N-system" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

step "start Mastodon ($IMAGE)"
cat >"$WORK/env" <<ENV
LOCAL_DOMAIN=localhost
RAILS_ENV=production
NODE_ENV=production
DB_HOST=$N-pg
DB_USER=mastodon
DB_NAME=mastodon
DB_PASS=mastodon
DB_PORT=5432
REDIS_HOST=$N-redis
REDIS_PORT=6379
SECRET_KEY_BASE=$(openssl rand -hex 64)
OTP_SECRET=$(openssl rand -hex 64)
ACTIVE_RECORD_ENCRYPTION_DETERMINISTIC_KEY=$(openssl rand -hex 16)
ACTIVE_RECORD_ENCRYPTION_KEY_DERIVATION_SALT=$(openssl rand -hex 16)
ACTIVE_RECORD_ENCRYPTION_PRIMARY_KEY=$(openssl rand -hex 16)
ENV
docker network create "$N" >/dev/null
docker volume create "$N-system" >/dev/null
docker run -d --name "$N-pg" --network "$N" -e POSTGRES_USER=mastodon -e POSTGRES_PASSWORD=mastodon -e POSTGRES_DB=mastodon postgres:17-alpine >/dev/null
docker run -d --name "$N-redis" --network "$N" redis:7-alpine >/dev/null
until_ok 60 docker exec "$N-pg" pg_isready -U mastodon
docker run --rm --network "$N" --env-file "$WORK/env" "$IMAGE" bundle exec rails db:setup >"$WORK/db.log" 2>&1 ||
  fail 'rails db:setup failed' "$(tail -40 "$WORK/db.log")"
docker run -d --name "$N-web" --network "$N" --env-file "$WORK/env" -v "$N-system:/mastodon/public/system" -p "127.0.0.1:$PORT:3000" "$IMAGE" bundle exec puma -C config/puma.rb >/dev/null
docker run -d --name "$N-sidekiq" --network "$N" --env-file "$WORK/env" -v "$N-system:/mastodon/public/system" "$IMAGE" bundle exec sidekiq >/dev/null
wait_for "http://127.0.0.1:$PORT/health" 300
make_media

# Production Mastodon insists on HTTPS; this proxy tells it the request already was.
cat >"$WORK/proxy.mjs" <<JS
import http from 'node:http';
http.createServer((req, res) => {
  const up = http.request({ host: '127.0.0.1', port: $PORT, path: req.url, method: req.method, headers: { ...req.headers, host: 'localhost', 'x-forwarded-proto': 'https' } }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on('error', (e) => { res.writeHead(502); res.end(String(e)); });
  req.pipe(up);
}).listen($PROXY_PORT, '127.0.0.1');
JS
node "$WORK/proxy.mjs" &
PROXY_PID=$!
wait_for "$BASE/api/v2/instance" 30

# Two local users (no mail is ever sent, so skip the MX check), each with a token.
rails() { docker exec "$N-web" bundle exec rails runner "$1" 2>>"$WORK/rails.log" | sed -n 's/^OUT=//p'; }
user_token() {
  rails "
a = Account.create!(username: '$1')
u = User.new(email: '$1@fanout-it.example', password: SecureRandom.hex(16), agreement: true, account: a)
u.save!(validate: false)
u.update_columns(approved: true, confirmed_at: Time.now.utc)
app = Doorkeeper::Application.create!(name: 'fanout-it-$1', redirect_uri: 'urn:ietf:wg:oauth:2.0:oob', scopes: 'read write')
puts 'OUT=' + Doorkeeper::AccessToken.create!(application: app, resource_owner_id: u.id, scopes: 'read write').token"
}
TOKEN=$(user_token fanoutit)
FAN=$(user_token fan)
[ -n "$TOKEN" ] && [ -n "$FAN" ] || fail 'could not create test users' "$(tail -40 "$WORK/rails.log" 2>/dev/null)"
api() { curl -s -H "authorization: Bearer $TOKEN" "$@"; }

step connect
expect '연결됨: mastodon/main' "$(run connect mastodon --name main --instance "$BASE" --token "$TOKEN")"

step 'doctor --live'
out=$(run doctor mastodon --live)
expect '테스트 게시물 삭제: 삭제함' "$out"
# The test status is "direct", which statuses_count ignores: look the status itself up instead.
DOCTOR_SID=$(sed -n 's|.*처리·게시: 게시됨 .*/\([0-9]*\)$|\1|p' <<<"$out")
[ -n "$DOCTOR_SID" ] || fail 'no status id in the doctor output' "$out"
[ "$(api -o /dev/null -w '%{http_code}' "$BASE/api/v1/statuses/$DOCTOR_SID")" = 404 ] || fail 'doctor --live left its status behind'

step 'post with thumbnail'
out=$(run post "$WORK/clip.mp4" --title 'fanout 통합 테스트' --description 'Mastodon 통합 테스트' --tags fanout \
  --thumbnail "$WORK/thumb.jpg" --to mastodon --md-visibility unlisted --md-alt '테스트 영상' --yes)
expect 'published' "$out"
POST=$(post_id "$out")
ME=$(api "$BASE/api/v1/accounts/verify_credentials" | json d.id)
SID=$(api "$BASE/api/v1/accounts/$ME/statuses" | json 'd[0].id')
[ "$(api "$BASE/api/v1/statuses/$SID" | json 'd.visibility+","+d.media_attachments[0].description+","+/thumbnails/.test(d.media_attachments[0].preview_url)')" = 'unlisted,테스트 영상,true' ] ||
  fail 'visibility, alt text or thumbnail not applied'

step edit
expect '반영함' "$(run edit "$POST" --title 'fanout 통합 테스트 (수정)')"
[ "$(api "$BASE/api/v1/statuses/$SID" | json 'd.media_attachments.length+","+d.content.includes("(수정)")')" = '1,true' ] || fail 'edit lost the video or the text'

step 'comments and reply'
curl -s -H "authorization: Bearer $FAN" -H 'content-type: application/json' "$BASE/api/v1/statuses" \
  -d "{\"status\":\"@fanoutit 영상 잘 봤어요\",\"in_reply_to_id\":\"$SID\",\"visibility\":\"unlisted\"}" >/dev/null
out=$(run comments "$POST")
expect '영상 잘 봤어요' "$out"
CID=$(sed -n 's/.*\[\([0-9]*\)\]$/\1/p' <<<"$out" | head -1)
for _ in 1 2; do expect '답글을 달았습니다' "$(run reply "$POST" mastodon "$CID" '고마워요' --yes)"; done
[ "$(api "$BASE/api/v1/statuses/$CID/context" | json 'd.descendants.length+","+d.descendants[0].mentions.map(m=>m.acct).join()')" = '1,fan' ] ||
  fail 'expected one reply that mentions the commenter'

step stats
expect '댓글 1' "$(run stats "$POST")"

step 'schedule and cancel it'
out=$(run post "$WORK/clip.mp4" --title 'fanout 예약 테스트' --to mastodon --md-visibility unlisted --at "$(date -u -d '+3 days' +%Y-%m-%dT%H:%M:%SZ)" --yes)
expect '예약 게시' "$out"
[ "$(api "$BASE/api/v1/scheduled_statuses" | json d.length)" = 1 ] || fail 'no scheduled status'
expect '삭제했습니다' "$(run remove "$(post_id "$out")" mastodon --yes)"
[ "$(api "$BASE/api/v1/scheduled_statuses" | json d.length)" = 0 ] || fail 'scheduled status not canceled'

step remove
expect '삭제했습니다' "$(run remove "$POST" mastodon --yes)"
[ "$(api -o /dev/null -w '%{http_code}' "$BASE/api/v1/statuses/$SID")" = 404 ] || fail 'status still there'

printf '\n✓ Mastodon integration passed\n'
