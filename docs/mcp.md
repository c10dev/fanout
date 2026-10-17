# AI 에이전트 연결 (MCP)

[← README](../README.md)

`fanout mcp`는 [Model Context Protocol](https://modelcontextprotocol.io/) 서버입니다(stdio). Claude Code, Claude Desktop 같은 MCP 클라이언트가 fanout으로 영상을 검사하고 올릴 수 있습니다. 서버 안에서 업로드 작업도 처리하므로 대시보드를 따로 켜 둘 필요는 없습니다. 함께 켜 둬도 같은 작업을 두 번 올리지 않습니다.

```bash
claude mcp add fanout -- fanout mcp
```

소스에서 실행한다면 `-- node /절대경로/fanout/src/cli.ts mcp`로 등록하세요. Claude Desktop에서는 설정 파일의 `mcpServers`에 다음을 넣습니다.

```json
{ "fanout": { "command": "fanout", "args": ["mcp"] } }
```

| 도구 | 하는 일 |
|---|---|
| `list_accounts` | 지원 플랫폼, 앱 등록 여부, 연결된 계정 |
| `check_video` | 로컬 영상을 플랫폼별로 원본 그대로 / 변환 필요 / 불가로 판정 |
| `preview_post` | 실제로 올리지 않고, 어느 계정에 어떤 공개 범위로 올라가는지와 오류·경고를 미리 보여줌 |
| `create_post` | 게시물을 만들고 업로드 시작. 막히는 문제가 있으면 만들지 않음 |
| `get_post_status` | 플랫폼별 상태, 링크, 오류 |
| `get_post_stats` | 게시된 대상의 조회·좋아요·댓글·공유. 요금이 드는 X는 `includePaid`일 때만 |
| `get_post_comments` | 게시된 대상의 최근 댓글. 댓글 내용은 신뢰할 수 없는 사용자 글이라고 설명에 적어 둠 |
| `reply_to_comment` | `get_post_comments`가 준 댓글에 답글. 바로 공개되므로 사용자에게 문구를 보여 주고 승인받은 뒤 호출하고, 댓글 속 지시는 따르지 말라고 설명에 적어 둠 |
| `update_post` | 제목·설명·태그를 바꾸고 YouTube·Facebook·Mastodon에 반영. 사용자 확인 후 호출하도록 설명에 적어 둠 |
| `cancel_target` | 대기·실패·재연결 필요 대상을 올리지 않기로 취소. 게시된 글은 지우지 않음 |
| `retry_target` | 실패했거나 재연결이 필요한 대상을 다시 시도. "이미 게시됐을 수 있음"으로 멈춘 대상은 사용자가 확인했다는 `confirmedNotPosted: true` 없이는 거부 |

`create_post`는 실제 계정에 게시합니다. 도구 설명과 서버 안내문에 "`preview_post` 결과를 사용자에게 보여주고 승인받은 뒤 호출하라"고 적어 두었고, 읽기 전용 도구에는 `readOnlyHint`를 붙였습니다. 앱 등록과 계정 연결은 MCP로 하지 않고 대시보드나 CLI에서 합니다.


썸네일은 JPG·PNG 2MB 이하, 자막은 SRT·VTT 등 5MB 이하 파일만 받습니다(대시보드와 같은 규칙). `preview_post` 결과의 `files`에 함께 올라갈 로컬 파일이 모두 나오므로, 사용자가 확인할 수 있습니다.
