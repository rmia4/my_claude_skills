---
name: codex
description: claude CLI를 부르지 않고 사용자가 낸 질문·지시를 Codex에게만 보내 답을 받는다. 토의·합의·비교 없이 Codex 답을 그대로 전하며 후속 질문을 이어 갈 수 있다. 사용자가 "/ai-discussion:codex", "Codex한테만 물어봐", "Codex 답만 받아 와", "claude 없이 codex만" 같은 말을 할 때 쓴다.
---

# /ai-discussion:codex — Codex 단독 모드

너는 이 질의의 **진행자**다. 답하는 쪽은 새 세션으로 호출되는 Codex 하나다. `claude` CLI는 부르지 않으므로 PATH에 없어도 된다. 너는 질문을 정리해 넘기고 Codex 답을 그대로 전한다. 절차는 스크립트가 처리한다.

## 실행 전 체크리스트

- 스크립트: `${CLAUDE_PLUGIN_ROOT}/scripts/discussion.mjs` (아래에서 `$SCRIPT`)
  - 경로가 `$`와 중괄호로 된 변수 이름으로 시작하면 채워지지 않은 것이다. `~/.claude/plugins/cache` 아래에서 `**/ai-discussion/**/scripts/discussion.mjs`를 Glob으로 찾아 그 절대 경로를 쓴다(여러 개면 가장 최근 것). 찾지 못하면 플러그인을 다시 설치하라고 사용자에게 알린다.
- 모든 명령: `node "$SCRIPT" <명령> <id> ... --mode codex`. **`--mode codex`는 `start`를 포함해 항상 붙인다**(아래 예에서는 생략). 다른 모드의 토의면 스크립트가 거부하고 맞는 스킬을 알려 준다. 그대로 사용자에게 전한다.
- `<id>`는 `last`(가장 최근 토의) 또는 사용자가 지정한 토의 이름을 쓴다.
- **Codex를 부르는 명령(`start`, `ask`, `next`)은 Bash `run_in_background: true`로 실행**하고 끝났다는 알림을 기다린다(1~3분). 기다리는 동안 폴링하지 않는다. 나머지 명령은 바로 실행한다.
- 진행자가 넘기는 파일(spec, 질문)은 scratchpad 폴더에 만든다. 기록은 현재 작업 폴더의 `discussions/<id>/`에 쌓인다.
- 중단·재개: 출력에 "상태: 중단"이 나오면 사유를 알리고, `next`로 같은 답변 단계를 다시 실행한다. 상태가 헷갈리면 `show`로 다시 본다.
- 설계 문서 `${CLAUDE_PLUGIN_ROOT}/docs/common.md`, `codex-mode-flow.md`는 이 절차로 판단이 서지 않을 때만 읽는다.

## 진행자 원칙

- Codex 답을 요약·평가하거나 고치지 않는다. 주제에 대한 자기 의견이나 보충을 더하지 않는다.
- 사용자 질문 문구는 고치지 않고 그대로 넘긴다.

## 0. 준비 (사용자 승인 필요)

1. 질문(지시)·배경·요구사항을 정리한다. Codex는 대화 맥락을 모르므로 이 내용이 전부다. `/ai-discussion:start`가 넘긴 입력(args)이 있으면 그대로 쓰고 빠진 것만 보완한다. 이미 받은 내용을 다시 묻지 않는다.
2. args에 진행 중인 토의 id가 있으면 새로 시작하지 않고 `show <id>`로 이어 간다.
3. 정리한 내용을 본문으로 보이고 시작 승인을 받는다. 승인 질문은 본문 끝에 적고 턴을 끝낸다.
4. 승인되면 spec 파일을 쓰고 `start --spec <파일>`을 백그라운드로 실행한다.
   - spec 필드: `mode`(항상 `"codex"`), `name`(폴더 이름, 10자 이내), `topic`(첫 질문), `background`, `requirements`(목록), `context`(Codex에게 넘길 참조 파일 목록), `workdir`(Codex가 읽기 전용으로 볼 폴더 또는 null), 선택 `usage`(true면 토큰 사용량 기록. 사용자가 알려 달라고 할 때만).
   - `context`에는 큰 파일 전문 대신 필요한 부분만 발췌해 넣고, 발췌마다 원래 경로와 줄 번호를 적는다.
   - start에서 넘어왔으면 `"via": "start"`를 넣는다.

## 1. 답변 뒤

1. 그 차례의 raw 파일(`discussions/<id>/raw/t<N>_codex.md`)을 Read한다.
2. 채팅에 Codex 답 전문을 그대로 옮기고, 끝에 raw 링크를 붙인다. 답 앞뒤에 요약이나 평가를 붙이지 않는다.
3. 후속 질문 또는 종료를 고르게 한다.

## 2. 후속 질문

사용자 말을 명령으로 옮기는 예:

| 사용자 말 | 명령 |
|---|---|
| "그럼 비용 기준으로 다시 답해 봐" | `ask last "그럼 비용 기준으로 다시 답해 봐"` (백그라운드) → 1단계 |
| 질문이 길거나 여러 줄 | scratchpad 파일에 쓰고 `ask last --file <파일>` |
| "끝" / "종료" | `end last` |

- Codex는 이전 질문과 자기 이전 답을 함께 받아 이어서 답한다.
- Claude 의견도 함께 듣고 싶다는 요청이면 이 토의를 끝내고 `/ai-discussion:compare`(비교 모드)를 권한다. 이 모드 안에서는 Claude를 부르지 않는다.
