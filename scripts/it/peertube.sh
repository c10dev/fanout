#!/usr/bin/env bash
# End-to-end check of the PeerTube provider against a throwaway PeerTube in Docker:
# connect, doctor --live, post with thumbnail and captions, edit, stats, comments, reply,
# schedule, remove. Needs docker, node 24, ffmpeg and curl. Nothing outside Docker is touched.
#   scripts/it/peertube.sh            (PT_IMAGE, PT_PORT to override)
source "$(dirname "$0")/lib.sh"

N=fanout-it-peertube
PORT="${PT_PORT:-9000}"
IMAGE="${PT_IMAGE:-chocobozzz/peertube:v8.3.1-trixie}"
PW=fanout-it-root-pw
BASE="http://localhost:$PORT"
cleanup() {
  docker rm -f "$N-app" "$N-pg" "$N-redis" >/dev/null 2>&1 || true
  docker network rm "$N" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

step "start PeerTube ($IMAGE)"
docker network create "$N" >/dev/null
docker run -d --name "$N-pg" --network "$N" -e POSTGRES_USER=peertube -e POSTGRES_PASSWORD=peertube -e POSTGRES_DB=peertube postgres:17-alpine >/dev/null
docker run -d --name "$N-redis" --network "$N" redis:7-alpine >/dev/null
until_ok 60 docker exec "$N-pg" pg_isready -U peertube
docker exec "$N-pg" psql -U peertube -d peertube -qc 'CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS unaccent;'
docker run -d --name "$N-app" --network "$N" -p "127.0.0.1:$PORT:9000" \
  -e PEERTUBE_DB_HOSTNAME="$N-pg" -e PEERTUBE_DB_USERNAME=peertube -e PEERTUBE_DB_PASSWORD=peertube -e PEERTUBE_DB_SSL=false \
  -e PEERTUBE_REDIS_HOSTNAME="$N-redis" -e PEERTUBE_WEBSERVER_HOSTNAME=localhost -e PEERTUBE_WEBSERVER_PORT="$PORT" -e PEERTUBE_WEBSERVER_HTTPS=false \
  -e 'PEERTUBE_TRUST_PROXY=["127.0.0.1","loopback","172.16.0.0/12"]' -e PEERTUBE_SECRET="$(openssl rand -hex 32)" \
  -e PEERTUBE_ADMIN_EMAIL=admin@fanout-it.example -e PT_INITIAL_ROOT_PASSWORD="$PW" "$IMAGE" >/dev/null
wait_for "$BASE/api/v1/config" 300
make_media

# A token of our own, to look at what fanout did through the API.
CLIENT=$(curl -s "$BASE/api/v1/oauth-clients/local")
TOKEN=$(curl -s -X POST "$BASE/api/v1/users/token" \
  -d "client_id=$(json d.client_id <<<"$CLIENT")&client_secret=$(json d.client_secret <<<"$CLIENT")&grant_type=password&username=root&password=$PW" | json d.access_token)
api() { curl -s -H "authorization: Bearer $TOKEN" "$@"; }

step connect
expect '연결됨: peertube/main' "$(run connect peertube --name main --instance "$BASE" --username root --password "$PW")"

step 'doctor --live'
out=$(run doctor peertube --live)
expect '테스트 게시물 삭제: 삭제함' "$out"
[ "$(api "$BASE/api/v1/users/me/videos" | json d.total)" = 0 ] || fail 'doctor --live left a video behind'

step 'post with thumbnail and captions'
out=$(run post "$WORK/clip.mp4" --title 'fanout 통합 테스트' --description 'PeerTube 통합 테스트입니다' --tags fanout,test \
  --thumbnail "$WORK/thumb.jpg" --caption "ko:$WORK/ko.vtt" --to peertube --pt-privacy unlisted --pt-comments enabled --yes)
expect 'published' "$out"
reject '올리지 못했습니다' "$out"
POST=$(post_id "$out")
VID=$(api "$BASE/api/v1/users/me/videos" | json 'd.data[0].id')
[ "$(api "$BASE/api/v1/videos/$VID" | json 'd.privacy.id+","+d.tags.join("|")')" = '2,fanout|test' ] || fail 'privacy or tags not applied'
[ "$(api "$BASE/api/v1/videos/$VID/captions" | json 'd.data.map(c=>c.language.id).join()')" = ko ] || fail 'caption missing'

step edit
expect '반영함' "$(run edit "$POST" --title 'fanout 통합 테스트 (수정)' --description '')"
[ "$(api "$BASE/api/v1/videos/$VID" | json d.name)" = 'fanout 통합 테스트 (수정)' ] || fail 'title not updated'

step 'comments and reply'
api -X POST -H 'content-type: application/json' "$BASE/api/v1/videos/$VID/comment-threads" -d '{"text":"통합 테스트 댓글"}' >/dev/null
out=$(run comments "$POST")
expect '통합 테스트 댓글' "$out"
CID=$(sed -n 's/.*\[\([0-9]*\)\]$/\1/p' <<<"$out" | head -1)
expect '답글을 달았습니다' "$(run reply "$POST" peertube "$CID" '통합 테스트 답글' --yes)"
[ "$(api "$BASE/api/v1/videos/$VID/comment-threads/$CID" | json 'd.children.map(c=>c.comment.text).join()')" = '통합 테스트 답글' ] || fail 'reply not found'

step stats
expect '댓글 2' "$(run stats "$POST")"

step schedule
out=$(run post "$WORK/clip.mp4" --title 'fanout 예약 테스트' --to peertube --pt-privacy public --at "$(date -u -d '+3 days' +%Y-%m-%dT%H:%M:%SZ)" --yes)
expect '예약 공개' "$out"
SVID=$(api "$BASE/api/v1/users/me/videos" | json 'd.data[0].id')
[ "$(api "$BASE/api/v1/videos/$SVID" | json 'd.privacy.id+","+d.scheduledUpdate.privacy')" = '3,1' ] || fail 'schedule not set'

step remove
expect '삭제했습니다' "$(run remove "$POST" peertube --yes)"
[ "$(api -o /dev/null -w '%{http_code}' "$BASE/api/v1/videos/$VID")" = 404 ] || fail 'video still there'

printf '\n✓ PeerTube integration passed\n'
