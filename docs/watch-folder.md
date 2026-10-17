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
- 영상별 JSON에는 `to`, `title`, `description`, `tags`(폴더 태그에 추가), `options`(플랫폼별로 덮어씀), `vars`, `at`, `ai`, `thumbnail`, `captions`(`{ "ko": "ditto.srt" }`)를 쓸 수 있습니다.
- 복사·내보내기 중인 파일을 집지 않도록, 크기와 수정 시각이 두 번 연속 같고 `--settle`초(기본 10) 이상 지난 파일만 올립니다.
- 플랫폼 제한을 변환으로 고칠 수 없으면(예: 90초가 넘는 영상의 Facebook Reels) `onBlocked: "skip"`이면 그 플랫폼만 건너뛰고, `"fail"`이면 영상 전체를 실패로 돌립니다.
- 게시물을 만든 영상은 `posted/`로, 실패한 영상은 `failed/`로 옮기고 이유를 `<파일>.error.txt`에 남깁니다. 같은 이름은 `clip (2).mp4`처럼 번호를 붙입니다.
- 설정에 적힌 계정이 하나라도 연결돼 있지 않으면 감시를 시작하지 않습니다.
- `--init`이 만드는 예시는 지금 연결된 계정 이름을 그대로 씁니다(연결된 게 없으면 `<플랫폼>:main`). YouTube는 처음에 `unlisted`로 만들어지니, 시험해 보고 `public`으로 바꾸세요.
