# 감시 폴더 (자동 업로드)

[← README](../README.md)

폴더에 영상을 넣기만 하면 정해 둔 플랫폼에 올립니다. 제목·설명·태그·플랫폼별 옵션은 폴더 설정에 한 번 적어 두고, 영상마다 바꿀 것만 옆에 JSON으로 둡니다.

```bash
node src/cli.ts watch ~/fanout-inbox --init     # 폴더와 예시 fanout.watch.json 만들기
node src/cli.ts watch ~/fanout-inbox            # 계속 감시 (시작할 때 올릴 계정·공개 범위를 보여주고 확인)
node src/cli.ts watch ~/fanout-inbox --once --yes   # 지금 있는 영상만 올리고 종료 (cron·작업 스케줄러용)
```

`fanout.watch.json` (폴더 공통):

```json
{
  "to": ["youtube:main", "tiktok:main", "instagram:main", "facebook:main"],
  "title": "{artist} - {song} | 가사로 배우는 한국어",
  "description": "{title}\n\n{tags}",
  "tags": ["kpop", "가사", "한국어공부"],
  "vars": { "artist": "Vocado" },
  "onBlocked": "skip",
  "options": {
    "youtube": { "privacy": "public", "madeForKids": false, "categoryId": "27" },
    "tiktok": { "mode": "inbox" },
    "instagram": { "caption": "{title}\n{tags}", "shareToFeed": true },
    "facebook": {}
  }
}
```

`ditto.mp4` 옆의 `ditto.json` (영상별, 있는 값만 덮어씀):

```json
{ "vars": { "artist": "NewJeans", "song": "Ditto" }, "tags": ["newjeans"], "at": "2026-10-20T18:00:00+09:00" }
```

- 템플릿 변수: `{name}`(파일 이름), `{date}`, `{title}`, `{tags}`(`#태그` 목록), 그리고 `vars`에 넣은 값. 값이 없는 변수가 있으면 올리지 않고 실패로 돌립니다(오타가 그대로 게시되지 않게).
- `"slots": ["12:00", "19:00"]`처럼 하루 중 올릴 시각을 정해 두면, 시각(`at`)이 따로 없는 영상은 아직 비어 있는 다음 슬롯(15분 이상 뒤)에 예약됩니다. 영상을 한꺼번에 넣어도 슬롯마다 하나씩 나갑니다. 시각은 fanout이 도는 컴퓨터의 현지 시간입니다(컨테이너라면 `TZ`를 지정하세요). 취소하거나 실패한 게시물의 슬롯은 다시 비어 있는 것으로 봅니다. 서머타임으로 건너뛰는 시각은 그날 슬롯에서 빠집니다.
  - 슬롯을 쓰면 YouTube는 예약 게시가 되고, YouTube 예약은 `public`만 됩니다. 그래서 `slots`와 YouTube를 함께 쓰려면 `options.youtube.privacy`를 `"public"`으로 해야 합니다(아니면 설정을 읽을 때 거부합니다).
  - 영상별 JSON 등으로 정해진 시각에 어떤 플랫폼이 올릴 수 없으면, 그 플랫폼은 이유와 함께 건너뛰고 나머지는 예약합니다(`onBlocked: "fail"`이면 영상 전체를 `failed/`로).
  - Facebook은 29일 안쪽만 예약할 수 있어, 그보다 먼 슬롯은 28일 전까지 기다렸다가 올립니다.
  - 120일 안에 빈 슬롯이 없으면 그 영상은 `failed/`로 옮깁니다. 예약 시각에 올리려면 `fanout watch`나 대시보드, `fanout worker` 중 하나가 켜져 있어야 합니다.
- 영상별 JSON에는 `to`, `title`, `description`, `tags`(폴더 태그에 추가), `options`(플랫폼별로 덮어씀), `vars`, `at`, `ai`, `thumbnail`, `captions`(`{ "ko": "ditto.srt" }`)를 쓸 수 있습니다.
- `thumbnail`과 `captions`의 파일은 감시 폴더 안의 상대 경로여야 하고(절대 경로, `../`, 폴더 밖을 가리키는 심볼릭 링크는 거부), 썸네일은 JPEG·PNG 2MB, 자막은 .srt·.vtt·.sbv·.scc·.ttml·.dfxp 5MB까지입니다. 폴더에 다른 사람이 파일을 넣을 수 있어도 그 설정으로 내 컴퓨터의 다른 파일이 올라가지 않게 하기 위해서입니다. 게시물을 만들 때 이 파일들을 fanout 데이터 폴더(`~/.fanout/media`)로 복사하고 업로드는 복사본을 읽으므로, 그 뒤에 폴더의 원본을 바꿔도 올라가는 내용은 바뀌지 않습니다. 심볼릭 링크와 다른 곳에 하드 링크된 파일은 받지 않습니다. 복사본은 대시보드에서 올린 파일과 같이 정리됩니다. 게시가 모두 끝나고 `--keep-days`(기본 7일)가 지나면 지우므로, 그 뒤 `fanout add`로 플랫폼을 더하면 썸네일·자막 없이 올라갑니다.
- 복사·내보내기 중인 파일을 집지 않도록, 크기와 수정 시각이 두 번 연속 같고 `--settle`초(기본 10) 이상 지난 파일만 올립니다.
- 플랫폼 제한을 변환으로 고칠 수 없으면(예: 90초가 넘는 영상의 Facebook Reels) `onBlocked: "skip"`이면 그 플랫폼만 건너뛰고, `"fail"`이면 영상 전체를 실패로 돌립니다.
- 게시물을 만든 영상은 `posted/`로, 실패한 영상은 `failed/`로 옮기고 이유를 `<파일>.error.txt`에 남깁니다. 같은 이름은 `clip (2).mp4`처럼 번호를 붙입니다.
- 같은 영상(파일 내용 기준)을 이미 올린 계정은 건너뜁니다. 모든 대상에 이미 올렸으면 그 영상은 `failed/`로 옮기고 이유를 남깁니다. 일부러 다시 올리려면 설정에 `"onDuplicate": "post"`를 넣으세요.
- 설정에 적힌 계정이 하나라도 연결돼 있지 않으면 감시를 시작하지 않습니다.
- `to`에 `:이름` 없이 플랫폼만 적으면 `main`, 그 플랫폼에 연결된 계정이 하나뿐이면 그 계정입니다. `main` 없이 여러 개면 `"tiktok:이름"`처럼 적으라고 알려 줍니다.
- `--init`이 만드는 예시는 지금 연결된 계정 이름을 그대로 씁니다(연결된 게 없으면 `<플랫폼>:main`). YouTube는 처음에 `unlisted`로 만들어지니, 시험해 보고 `public`으로 바꾸세요.
