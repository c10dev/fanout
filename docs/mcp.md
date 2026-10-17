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
| `retry_target` | 실패했거나 재연결이 필요한 대상을 다시 시도 |

`create_post`는 실제 계정에 게시합니다. 도구 설명과 서버 안내문에 "`preview_post` 결과를 사용자에게 보여주고 승인받은 뒤 호출하라"고 적어 두었고, 읽기 전용 도구에는 `readOnlyHint`를 붙였습니다. 앱 등록과 계정 연결은 MCP로 하지 않고 대시보드나 CLI에서 합니다.
