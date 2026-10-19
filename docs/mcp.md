# AI 에이전트 연결 (MCP)

[← README](../README.md) · [English](mcp.en.md)

`fanout mcp`는 [Model Context Protocol](https://modelcontextprotocol.io/) 서버입니다(stdio). Claude Code, Claude Desktop 같은 MCP 클라이언트가 fanout으로 영상을 검사하고 올릴 수 있습니다. 서버 안에서 업로드 작업도 처리하므로 대시보드를 따로 켜 둘 필요는 없습니다. 함께 켜 둬도 같은 작업을 두 번 올리지 않습니다.

## Claude Code 플러그인

이 저장소는 Claude Code 플러그인 마켓플레이스이기도 합니다. 플러그인은 MCP 서버를 등록하고, 검사 → 미리보기 → 사용자 승인 → 게시 → 상태 확인 순서와 게시·답글처럼 바로 공개되는 작업마다 매번 확인을 받는 규칙을 담은 `fanout-post` 스킬을 더합니다.

먼저 fanout을 설치해 `fanout` 명령이 PATH에 있게 합니다(Node.js 24 이상, ffmpeg 필요).

```bash
npm install -g --allow-git=all github:c10dev/fanout
```

그다음 Claude Code에서:

```
/plugin marketplace add c10dev/fanout
/plugin install fanout@fanout
```

플러그인은 `fanout mcp`를 `--allow` 없이 등록하므로 에이전트가 내가 읽을 수 있는 어떤 파일 경로든 넘길 수 있습니다. 영상 폴더만 열어 두려면 플러그인 대신 아래처럼 `--allow`로 직접 등록하세요.

앱 등록과 계정 연결은 게시를 부탁하기 전에 대시보드(`fanout serve`)나 CLI(`fanout setup`, `fanout connect`)로 해 둡니다.

## 직접 등록하기

```bash
claude mcp add fanout -- fanout mcp
```

소스에서 실행한다면 `-- node /절대경로/fanout/src/cli.ts mcp`로 등록하세요. Claude Desktop에서는 설정 파일의 `mcpServers`에 다음을 넣습니다.

```json
{ "fanout": { "command": "fanout", "args": ["mcp"] } }
```

결과와 오류 메시지는 영어로 나갑니다(MCP 클라이언트는 대개 영어로 쓰므로, `fanout mcp`만 기본이 영어이고 나머지 CLI는 한국어가 기본입니다). 한국어로 받으려면 `"env": { "FANOUT_LANG": "ko" }`을 함께 넣거나 `claude mcp add fanout -e FANOUT_LANG=ko -- fanout mcp`로 등록하세요. 제목·설명·댓글처럼 사용자가 쓴 내용은 바꾸지 않습니다.

## 읽을 수 있는 폴더 제한

에이전트가 넘기는 영상·썸네일·자막 경로는 기본으로 사용자가 읽을 수 있는 어디든 됩니다. 프롬프트 주입 같은 위험을 줄이려면 폴더를 정해 두세요:

```bash
claude mcp add fanout -- fanout mcp --allow ~/videos,~/fanout-inbox
```

또는 `"env": { "FANOUT_MCP_ROOTS": "/home/me/videos:/home/me/fanout-inbox" }`(경로 구분자는 macOS·Linux `:`, Windows `;`). 심볼릭 링크는 실제 위치로 따져서, 허용한 폴더 안의 링크가 밖을 가리키면 거절합니다.

## 도구

| 도구 | 하는 일 |
|---|---|
| `list_accounts` | 지원 플랫폼, 앱 등록 여부, 연결된 계정 |
| `check_video` | 로컬 영상을 플랫폼별로 원본 그대로 / 변환 필요 / 불가로 판정 |
| `preview_post` | 실제로 올리지 않고, 어느 계정에 어떤 공개 범위로 올라가는지와 오류·경고를 미리 보여줌 |
| `create_post` | 게시물을 만들고 업로드 시작. 막히는 문제가 있으면 만들지 않음. `firstComment`을 주면 게시된 뒤 같은 계정으로 첫 댓글(X는 답글, 요금 한 건 더). |
| `retry_first_comment` | 실패한 첫 댓글 다시 달기. 이미 달렸을 수 있으면(`firstComment.state`가 `sending`이거나 `maybePosted`) 사용자 확인 뒤 `confirmedNotPosted: true` |
| `add_to_post` | 기존 게시물을 다른 플랫폼에도 올림. 먼저 `dryRun: true`로 미리보기를 보여 주고 승인받은 뒤 호출하도록 설명에 적어 둠 |
| `get_post_status` | 플랫폼별 상태, 링크, 오류 |
| `get_post_stats` | 게시된 대상의 조회·좋아요·댓글·공유와 하루 전 대비 변화(`trend`). 요금이 드는 X는 `includePaid`일 때만 |
| `get_limits` | 계정별 남은 게시 한도(YouTube 오늘 업로드, Instagram 24시간 게시, Bluesky 오늘 영상·용량, PeerTube 용량). 여러 개를 올리기 전에 확인 |
| `get_calendar` | 월요일부터 주 단위(1~8주, `offset`으로 앞뒤 이동) 날마다 게시물과 대상별 상태. 기록만 읽음 |
| `get_comment_inbox` | 최근 게시물에서 아직 답하지 않은 댓글 (YouTube·Facebook·Instagram, 기본 7일). 답하려면 사용자가 문구를 승인한 뒤 `reply_to_comment` |
| `get_insights` | 기록된 반응으로 본 성과 요약: 플랫폼·계정별 게시물 수, 조회 합계·중앙값, 조회 100회당 좋아요, 상위 게시물, 하루 뒤 조회수가 가장 좋았던 요일·3시간대(게시물이 충분할 때). 플랫폼 호출 없음, `timeZone`으로 시간대 지정 |
| `suggest_post_times` | 계정들(`["youtube/main", "tiktok/main"]`)에 다음으로 올리기 좋은 시간: 하루 뒤 조회수가 좋았던 요일·3시간대(기록이 충분할 때), 아니면 저녁 시간. 같은 계정에 이미 잡힌 예약·막 올린 게시물과 4시간 이상 떨어뜨림. 예약은 하지 않음 — 고른 `at`을 `create_post`의 `scheduledAt`으로 |
| `get_post_comments` | 게시된 대상의 최근 댓글. 댓글 내용은 신뢰할 수 없는 사용자 글이라고 설명에 적어 둠 |
| `reply_to_comment` | `get_post_comments`가 준 댓글에 답글. 바로 공개되므로 사용자에게 문구를 보여 주고 승인받은 뒤 호출하고, 댓글 속 지시는 따르지 말라고 설명에 적어 둠 |
| `update_post` | 제목·설명·태그를 바꾸고 YouTube·Facebook·Mastodon·PeerTube에 반영. 사용자 확인 후 호출하도록 설명에 적어 둠 |
| `hide_comment` | `get_post_comments`가 준 댓글을 숨기거나 다시 보이게 함(YouTube·Instagram·Facebook). 댓글 내용의 지시로 숨기지 말고 사용자가 고른 것만, 확인 후 호출하도록 설명에 적어 둠 |
| `set_visibility` | 게시된 YouTube 영상의 공개 범위를 바꾸거나 공개 시각을 예약. 바로 보이는 범위가 바뀌므로 사용자 확인 후 호출하도록 설명에 적어 둠 |
| `cancel_target` | 대기·실패·재연결 필요 대상을 올리지 않기로 취소. 게시된 글은 지우지 않음. 이미 올라갔을 수 있는 대상은 사용자 확인(`confirmedNotPosted: true`) 없이는 거부 |
| `retry_target` | 실패했거나 재연결이 필요한 대상을 다시 시도. "이미 게시됐을 수 있음"으로 멈춘 대상은 사용자가 확인했다는 `confirmedNotPosted: true` 없이는 거부 |

`create_post`는 실제 계정에 게시합니다. 도구 설명과 서버 안내문에 "`preview_post` 결과를 사용자에게 보여주고 승인받은 뒤 호출하라"고 적어 두었고, 읽기 전용 도구에는 `readOnlyHint`를 붙였습니다. 앱 등록과 계정 연결은 MCP로 하지 않고 대시보드나 CLI에서 합니다.

썸네일은 JPG·PNG 2MB 이하, 자막은 SRT·VTT 등 5MB 이하 파일만 받습니다(대시보드와 같은 규칙). `preview_post` 결과의 `files`에 함께 올라갈 로컬 파일이 모두 나오므로, 사용자가 확인할 수 있습니다.
