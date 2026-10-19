# 운영

[← README](../README.md)

## 디스크 정리

```bash
node src/cli.ts prune --dry-run   # 지울 파일만 보여주기
node src/cli.ts prune --days 7
```

`~/.fanout` 안의 파일만 지웁니다. 감시 폴더의 `posted/`처럼 사용자가 둔 파일은 건드리지 않습니다.

- **게시 안 된 업로드**: 대시보드에 올렸지만 하루가 지나도록 게시물로 만들지 않은 원본
- **게시 끝난 원본**: 모든 플랫폼에서 게시됐거나 앱으로 넘어간 지 `--days`일(기본 7) 지난 원본. 실패한 대상이 남아 있으면 다시 시도할 수 있게 남겨 둡니다
- **오래된 변환 파일**: `--days`일 지난 변환 캐시. 이어 올릴 업로드가 하나라도 남아 있으면 지우지 않습니다. 다시 변환한 파일은 바이트가 달라질 수 있어서입니다

`fanout serve`는 시작할 때와 6시간마다 같은 기준으로 정리합니다. 기간은 `--keep-days`로 바꾸고, `--no-prune`으로 끌 수 있습니다. 정리된 원본은 나중에 그 게시물에 플랫폼을 추가(`fanout add`, 대시보드 "플랫폼 추가")할 수 없게 되니, 며칠 뒤에 다른 플랫폼에도 올릴 생각이면 `--keep-days`를 늘려 두세요.

## 여러 프로세스를 함께 쓸 때

대시보드, `worker`, `watch`, `mcp`, CLI의 `post`·`run`·`retry`는 같은 `~/.fanout` 데이터베이스를 함께 써도 됩니다.

- 각 작업은 처리하기 전에 SQLite에서 원자적으로 잠급니다(15분, 작업 중 5분마다 연장). 그래서 같은 대상을 두 프로세스가 동시에 올리지 않습니다.
- 잠금을 쥔 프로세스가 같은 컴퓨터에서 죽었으면 바로 넘겨받습니다. 재시작한 컨테이너에서 pid가 같아도 마찬가지입니다.
- 다른 프로세스의 쓰기는 최대 10초 기다립니다.
- 플랫폼에서 24시간 넘게 처리가 끝나지 않으면 `processing_timeout`으로 실패 처리합니다.

## 알림

감시 폴더나 백그라운드 작업이 사람 없이 돌 때, 게시가 끝나거나 실패하면 webhook으로 알립니다.

```bash
fanout notify set https://hooks.slack.com/services/…      # 또는 Discord webhook, 아무 HTTPS URL
fanout notify set <URL> --events failed,needs_reauth       # 실패만 받기
fanout notify test
fanout notify off
```

대시보드 설정 → 일반의 "알림"에서도 같은 설정을 할 수 있습니다(127.0.0.1 전용).

- Slack·Discord webhook 주소는 알아보고 그 형식으로 보냅니다. 그 밖의 주소에는 상태 변경이면 `{ event: "target.state", state, platform, account, postId, targetId, title, url, error, text }`, 게시물 경고면 `{ event: "alert", platform, account, postId, targetId, title, url, alert, text }`, 로그인 만료 예정이면 `{ event: "expiring", platform, account, expiresAt, text }` JSON을 보냅니다.
- 기본으로 알리는 것: 게시됨, 앱에서 마무리 필요(TikTok 수신함), 실패, 재연결 필요, 그리고 `alert`(게시된 뒤 생긴 문제, 예: Meta 저작권 검사로 음소거·차단)와 `expiring`(계정 로그인이 2주 안에 만료, 예: YouTube 동의 화면이 "Testing"이면 7일, TikTok은 약 1년). `removed`는 `--events`로 고를 때만. 예전에 기본값과 다른 목록을 직접 골라 저장했다면 `alert`·`expiring`은 다시 골라야 받습니다(대시보드가 예전 기본값 그대로 저장한 목록은 새 기본값으로 봅니다).
- `digest`(주간 요약)는 고를 때만 보냅니다(`--events …,digest` 또는 대시보드 알림 카드). 한 주에 한 번, 그 주 첫 점검 때(작업 처리기가 몇 시간마다 돎) 최근 7일의 플랫폼별 게시물 수·조회·최고 게시물, 실패한 게시, 곧 만료되는 로그인을 기록만으로 모아 보냅니다(플랫폼 호출 없음). 주는 `FANOUT_TZ`(없으면 서버 시간대) 기준 ISO 주입니다.
- `alert`와 `expiring`은 같은 일에 한 번만 보냅니다(만료는 재연결로 만료일이 바뀌면 다시). 만료 예정은 `fanout accounts`와 대시보드 설정의 앱별 계정 옆에도 표시됩니다.
- webhook 주소는 암호화해서 저장합니다. 환경 변수 `FANOUT_WEBHOOK_URL`이 있으면 그쪽을 쓰고, 이때 받을 이벤트는 `FANOUT_WEBHOOK_EVENTS=failed,digest`처럼 고릅니다(없으면 기본값).
- 알림은 5초 안에 보내지 못하면 포기하고 경고만 남깁니다. 업로드를 막거나 늦추지 않습니다.

## 백업과 복원

```bash
fanout backup ~/fanout-backups            # fanout-<시각>/ 폴더에 DB 스냅샷과 secret.key
fanout backup ~/fanout-backups --without-key
```

- 대시보드나 worker가 돌고 있어도 안전합니다(SQLite `VACUUM INTO`로 일관된 스냅샷을 만듭니다).
- 토큰과 앱 비밀값은 암호화된 채로 들어가지만, 진행 중인 업로드의 재개 정보(플랫폼의 업로드 세션 URL)는 그대로 들어 있습니다. 백업 파일도 0600 권한으로 만들어지니 다른 사람과 나누지 마세요. `--without-key`로 만든 백업은 키 없이는 비밀값을 풀 수 없습니다.
- `secret.key`가 함께 들어가므로 백업 폴더가 있으면 모든 계정 토큰을 풀 수 있습니다. 안전한 곳에 두세요. 키를 `FANOUT_SECRET_KEY`로 주고 있다면 백업에 넣지 않으니 따로 보관하세요.
- **복원**: 대시보드·worker·watch·mcp를 모두 끈 뒤 `fanout restore <백업 폴더>`로 되돌립니다. fanout이 하는 일은 다음과 같습니다.
  - 백업 DB가 온전한지, 저장된 토큰을 쓸 키(백업의 `secret.key` 또는 `FANOUT_SECRET_KEY`)로 풀 수 있는지 먼저 확인합니다.
  - 다른 fanout 프로세스(대시보드·worker·watch·mcp)가 데이터베이스를 열고만 있어도 거부합니다(`--force`로 무시). 그대로 두면 그 프로세스가 옮겨 둔 이전 파일에 계속 쓰기 때문입니다.
  - 실행 중인 폴더를 그대로 복사한 것처럼 WAL 파일이 함께 있는 백업도 SQLite를 거쳐 복사하므로 내용이 빠지지 않습니다.
  - 지금 데이터(`fanout.db`, WAL 파일, `secret.key`)는 지우지 않고 `FANOUT_HOME/before-restore-<시각>/`으로 옮겨 둡니다.

  ```bash
  fanout restore ~/fanout-backups/fanout-2026-10-17T03-00-00-000Z
  ```

## 게시 기록 내보내기

```bash
fanout export --out posts.csv              # 엑셀·구글 시트에서 바로 열리는 CSV
fanout export --format json > posts.json
```

게시물 × 플랫폼마다 한 줄씩, 상태, 링크, 오류, 마지막으로 가져온 반응 수치가 들어갑니다. 수식으로 해석될 수 있는 셀(`=`, `+`, `-`, `@`로 시작)은 앞에 `'`를 붙여 막습니다.

## 상태 확인

대시보드는 `GET /healthz`에 토큰 없이 `{"ok":true}`로 답합니다. Docker 이미지는 이 경로로 HEALTHCHECK를 합니다.
