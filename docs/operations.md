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

`fanout serve`는 시작할 때와 6시간마다 같은 기준으로 정리합니다. 기간은 `--keep-days`로 바꾸고, `--no-prune`으로 끌 수 있습니다.

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

대시보드 설정 탭의 "알림" 카드에서도 같은 설정을 할 수 있습니다(127.0.0.1 전용).

- Slack·Discord webhook 주소는 알아보고 그 형식으로 보냅니다. 그 밖의 주소에는 `{ event, state, platform, account, postId, targetId, title, url, error, text }` JSON을 보냅니다.
- 기본으로 알리는 상태: 게시됨, 앱에서 마무리 필요(TikTok 수신함), 실패, 재연결 필요.
- webhook 주소는 암호화해서 저장합니다. 환경 변수 `FANOUT_WEBHOOK_URL`이 있으면 그쪽을 씁니다.
- 알림은 5초 안에 보내지 못하면 포기하고 경고만 남깁니다. 업로드를 막거나 늦추지 않습니다.
