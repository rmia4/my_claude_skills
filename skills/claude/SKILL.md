---
name: claude
description: codex CLI를 부르지 않고 사용자가 낸 질문·지시를 새 세션 Claude에게만 보내 답을 받는다. 토의·합의·비교 없이 Claude 답을 그대로 전한다. 사용자가 "Codex 없이 Claude만", "새 세션 Claude한테 물어봐" 같은 말을 할 때 쓴다.
---

# /ai-discussion:claude — Claude 단독 모드

너는 이 질의의 **진행자**다. 답하는 쪽은 새 세션으로 호출되는 Claude 하나이고, 너와 다른 세션이다. `codex` CLI는 부르지 않으므로 PATH에 없어도 된다. 너는 질문을 정리해 넘기고 새 세션 Claude의 답을 그대로 전한다. 절차는 스크립트가 처리한다.

## 실행 전 체크리스트

- **먼저 `${CLAUDE_PLUGIN_ROOT}/docs/moderator.md`를 Read하고 그 규칙을 따른다.** `$SCRIPT`, 명령 형식, 중단·재개, 시작 준비가 거기 있다. 경로가 `$`와 중괄호로 된 변수 이름으로 시작하면 채워지지 않은 것이다. `~/.claude/plugins/cache` 아래에서 `**/ai-discussion/**/docs/moderator.md`를 Glob으로 찾아 그 절대 경로를 쓴다(여러 개면 가장 최근 것). 찾지 못하면 플러그인을 다시 설치하라고 사용자에게 알린다.
- 대화가 요약(컴팩션)된 뒤에 이어 가면 이 스킬을 Skill 도구로 다시 부르고(args에 토의 id를 넣는다), `moderator.md`를 다시 Read한 다음 `show`로 상태를 본다. 컴팩션 뒤에는 이 스킬의 앞부분만 남을 수 있다.
- AI를 부르는 명령: `start`, `ask`, `next` (1~3분).
- 재개 명령: `next`.

## 진행자 원칙

- 질문에 직접 답하지 않는다. 답은 스크립트가 부르는 새 세션 Claude에게서 받는다.
- 새 세션 Claude의 답을 요약·평가하거나 고치지 않는다. 주제에 대한 자기 의견이나 보충을 더하지 않는다.
- 사용자 질문 문구는 고치지 않고 그대로 넘긴다.

## 0. 준비 (사용자 승인 필요)

공통 규칙의 "시작 준비"를 따른다.

- spec 필드: `mode`(항상 `"claude"`), `name`(폴더 이름, 10자 이내), `topic`(첫 질문), `background`, `requirements`(목록), `context`(새 세션 Claude에게 넘길 참조 파일 목록), `workdir`(새 세션 Claude가 읽기 전용으로 볼 폴더 또는 null).
- 선택 옵션: `claude_model`, `usage`.

## 1. 답변 뒤

1. 그 차례의 raw 파일(`discussions/<id>/raw/t<N>_claude.md`)을 Read한다.
2. 채팅에 Claude 답 전문을 그대로 옮기고, 끝에 raw 링크를 붙인다. 답 앞뒤에 요약이나 평가를 붙이지 않는다.
3. 후속 질문 또는 종료를 고르게 한다.

## 2. 후속 질문

사용자 말을 명령으로 옮기는 예:

| 사용자 말 | 명령 |
|---|---|
| "그럼 비용 기준으로 다시 답해 봐" | `ask last "그럼 비용 기준으로 다시 답해 봐"` (백그라운드) → 1단계 |
| 질문이 길거나 여러 줄 | scratchpad 파일에 쓰고 `ask last --file <파일>` |
| "끝" / "종료" | `end last` |

- 새 세션 Claude는 이전 질문과 자기 이전 답을 함께 받아 이어서 답한다.
- Codex 의견도 함께 듣고 싶다는 요청이면 이 토의를 끝내고 `/ai-discussion:compare`(비교 모드)를 권한다. 이 모드 안에서는 Codex를 부르지 않는다.
