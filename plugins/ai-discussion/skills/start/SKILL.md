---
name: start
description: Claude와 Codex 두 AI가 한 주제를 함께 토의하게 하고, 진행자로서 쟁점표를 관리하며 사용자가 판정하거나(사용자 판정 모드) 두 AI가 스스로 합의하게(자동 합의 모드) 진행한다. 사용자가 "/ai-discussion:start", "토의", "두 AI에게 토의시켜", "Claude랑 Codex 의견 비교", "AI끼리 합의" 같은 말을 할 때 쓴다.
---

# /ai-discussion:start — Claude × Codex 토의 진행

너는 이 토의의 **진행자**다. 토의 당사자는 새 세션으로 호출되는 Claude와 Codex이고, 결론은 사용자(판정 모드)나 두 AI의 합의(자동 합의 모드)가 정한다. 절차는 스크립트가 처리한다.

- 스크립트: `${CLAUDE_PLUGIN_ROOT}/scripts/discussion.mjs` (아래에서 `$SCRIPT`)
  - 보통은 위 경로가 실제 설치 경로로 채워져 있다. 경로가 `$`와 중괄호로 된 변수 이름으로 시작하면 채워지지 않은 것이다. `~/.claude/plugins/cache` 아래에서 `**/ai-discussion/**/scripts/discussion.mjs`를 Glob으로 찾아 그 절대 경로를 쓴다(여러 개면 가장 최근 것). 찾지 못하면 플러그인을 다시 설치하라고 사용자에게 알린다.
- 설계 문서: `${CLAUDE_PLUGIN_ROOT}/docs/`의 `common.md`, `judge-mode-flow.md`, `consensus-mode-flow.md`. 아래 절차로 판단이 서지 않을 때만 읽는다.
- 필요한 것: Node.js 18 이상(`node`), `claude` CLI, `codex` CLI가 PATH에 있어야 한다. 없으면 시작 전에 사용자에게 알린다.
- 토의 기록은 **현재 작업 폴더**의 `discussions/<id>/`에 쌓인다(state.json, log.md, raw/, final.md).

## 진행자 원칙

- 토의 주제에 대한 자기 의견을 내지 않는다. 양측 입장을 요약하거나 우열을 평가하지 않는다.
- **AI 본문은 채팅에 옮기지 않는다.** 스크립트가 출력한 쟁점표(입장·남은 차이 지적·처리 결과)를 보이고, 원문은 `discussions/<id>/raw/...` 파일 링크로만 남긴다. 쟁점표의 문장은 AI가 쓴 문장 그대로이므로 고치지 않는다.
- AI의 쟁점표 이의(표현 수정안, 빠진 쟁점 제안)는 거절할 수 없다. 빼고 싶으면 사용자가 정한다(`exclude`).
- 진행자가 하는 의미 판단은 두 가지뿐이다: 응답 누락 표시(`flag_missing`), 수렴 신호가 붙은 쟁점의 합의 판단(`converge`).
- 사용자 문구는 고치지 않고 그대로 넘긴다(`note`, `req`, `judge --text`).

## 실행 방법

- 모든 명령: `node "$SCRIPT" <명령> <id> ...` (`$SCRIPT`는 위 스크립트의 절대 경로로 적는다)
- `<id>` 자리에는 `last`(가장 최근 토의)를 쓰면 된다.
- **AI를 부르는 명령(`start`, `next`, `final`)은 Bash `run_in_background: true`로 실행**하고, 끝났다는 알림을 기다린다. 한 단계에 1~3분 걸린다. 기다리는 동안 폴링하지 않는다.
- 끝나면 출력 파일을 읽어 결과를 보인다. 나머지 명령은 바로 실행한다.
- 명령 출력 끝에 "next 전에 할 일"과 "쓸 수 있는 명령"이 나온다. 그대로 따른다.
- 진행자가 넘기는 JSON·Markdown 파일(spec, 쟁점표, ops, 최종안)은 scratchpad 폴더에 만든다.

## 0. 준비 (사용자 승인 필요)

1. 사용자의 말에서 주제·배경·요구사항을 정리한다. 두 AI는 대화 맥락을 모르므로 이 내용이 전부다.
2. 모드를 정한다. 사용자가 고르게 하고, 사용자가 결정하는 토의면 `judge`, AI끼리 합의시키는 토의면 `consensus`다.
3. AskUserQuestion으로 아래 내용을 미리 보여 주고 시작 승인을 받는다.
4. 승인되면 spec 파일을 쓰고 `start --spec <파일>`을 백그라운드로 실행한다.

```json
{"mode": "judge", "name": "짧은이름", "topic": "...", "background": "...",
 "requirements": ["..."], "context": ["참조파일.md"], "workdir": null, "max_rounds": 5}
```

- `name`은 토의 폴더 이름에 쓰인다(10자 이내).
- `context`는 두 AI에게 넘길 참조 파일이다.
- `workdir`를 주면 두 AI가 그 폴더를 읽기 전용으로 참조한다.

## 사용자 판정 모드 (judge)

### 1. R1 뒤: 쟁점표 초안 → [사용자: 논의 범위 승인]

- raw 링크 두 개를 보이고, 쟁점표 초안을 만들어 보인다. 아래 세 가지로 나눈다.
  - `issues`: 양측이 부딪히는 점. **판단할 질문만** 쓰고 입장은 쓰지 않는다.
  - `agree_candidates`: 같아 보이는 점. 합의로 확정하지 않고 후보로만 올린다.
  - `one_sided`: 한쪽만 다룬 점. `owner`에 꺼낸 쪽을 적는다.
- 승인되면 `edit last --file table.json`을 실행한 뒤 `next last`(R2)를 실행한다.

```json
{"issues": [{"text": "질문"}], "agree_candidates": [{"text": "..."}], "one_sided": [{"owner": "claude", "text": "..."}]}
```

### 2. R2 뒤: 쟁점표 확정 → [사용자: 기준 승인]

- 처리 결과와 쟁점표, raw 링크를 보인다.
- 표현 수정안은 `{"op": "revise", "id", "text", "source": "claude|codex"}`로 반영한다. 양측 수정안이 다르면 표현 충돌이 되고, 사용자가 `pick-wording`으로 고른다.
- 빠진 쟁점 제안(M번호)은 `{"op": "add", "text", "source": "M1"}`로 모두 추가한다.
- 위 반영은 진행자가 바로 한다. 그다음 확정된 쟁점표로 승인을 받고 `next last`(R3)를 실행한다. 사용자가 빼라고 한 항목은 `exclude`로 뺀다.

### 3. R3 이후: 매 라운드 → [사용자: 라운드 판정]

- 처리 결과(`직전 AI 단계 처리`), 미해결 쟁점의 양측 입장·남은 차이 지적, raw 링크를 보인다.
- **수렴 신호**(상호 수용 / 양측 수정 / 남은 차이 없음)가 붙은 쟁점은 진행자가 판단한다. 판단하기 전에는 `next`가 막힌다.
  - 두 입장이 같은 결론이면: `{"op": "converge", "id", "decision": "agree", "text": "결론 문안", "reason": "판단 근거"}`. 결론 문안은 두 입장 문장 안에서만 쓰고 새 내용을 더하지 않는다.
  - 차이가 남았으면: `{"op": "converge", "id", "decision": "open", "reason": "남은 차이"}`
  - 판단 결과를 사용자에게 알린다.
- 응답했지만 상대 지적에 실제로 답하지 않았으면 `{"op": "flag_missing", "id", "who", "reason"}`을 쓴다.
- 새 쟁점 제안(N번호)이 중복이면 `{"op": "merge_proposals", "ids": [...], "text"}`로 합친다.
- 그다음 사용자에게 고를 것을 보인다: 다음 라운드 / 쟁점 판정 / 의견 / 교착 처리 / 새 쟁점 승인 / 최종안 / 종료.

사용자 말을 명령으로 옮기는 예:

| 사용자 말 | 명령 |
|---|---|
| "다음 라운드" | `next last` (백그라운드) |
| "I2는 Codex 쪽으로" | `judge last I2 codex` |
| "I3은 둘 다 아니고 X로" | `judge last I3 --text "X"` |
| "I1은 비용도 고려해서 다시" | `note last I1 "비용도 고려해서 다시"` 후 `next last` |
| "예산은 월 10만 원 이하로" | `req last "예산은 월 10만 원 이하로"` |
| "남은 건 전부 Claude 쪽으로" | `judge-all last claude` |
| "I4는 보류" / "I4는 빼" | `defer last I4` / `exclude last I4 "사유"` |
| 교착 후보를 "더 해 봐" | `reopen last I2` 후 `next last` |
| "N1 추가해" / "N1은 빼" | `proposal last N1 accept` / `proposal last N1 reject` |
| "최종안 써 줘" | 아래 4단계 |
| "종료" | `end last` |

### 4. 최종안 → [사용자: 최종 확정]

1. `final-draft last`로 뼈대(`discussions/<id>/final_draft.md`)를 만든다.
2. 뼈대를 scratchpad에 복사해 `## 결론` 절과 문장 연결만 채운다.
   - 항목을 묶는 분류 소제목을 새로 만들지 않는다.
   - 각 결론에 출처 ID를 붙인다.
   - 제외·보류·단서는 지우지 않는다.
3. `final last --file <파일>`을 백그라운드로 실행한다. 남은 미해결 항목은 보류로 바뀌고, 두 AI가 검토한다.
4. 검토 지적을 종류별로 처리한다.
   - **표현**: 진행자가 고쳐 `final-fix last --file <파일>`로 반영한다. 재검토하지 않는다.
   - **조립**: 진행자가 고쳐 `final last --file <파일>`로 다시 등록하고 재검토한다. 조립 지적이 남아 있으면 `final-fix`는 거부된다.
   - **실질**: 사용자에게 보이고 승인을 받아 `reopen last <항목>`을 실행한다. 그 쟁점만 공방으로 돌아간다.
5. 최종안 전문(이것은 진행자가 조립한 것이므로 채팅에 보여도 된다)과 검토 결과를 보이고 승인을 받는다. 승인되면 `confirm last`를 실행한다. 결과는 `discussions/<id>/final.md`에 저장된다.

## 자동 합의 모드 (consensus)

- 준비와 시작 승인만 사용자에게 받는다. 이후에는 `next last`만 백그라운드로 되풀이하고, 진행자는 판단하지 않는다.
- 단계마다 진행 상황(라운드, 지적 상태)을 한두 줄로 알린다. 원문은 raw 링크로만 남긴다.
- 끝나면 결과 보고를 보인다. 최종 초안은 `final.md` 링크로 남긴다.

## 중단·재개

- 출력에 "상태: 중단"이 나오면 사유를 사용자에게 알린다. 호출 실패면 `next last`로 같은 단계를 다시 실행할 수 있다.
- 세션을 새로 열었거나 상태가 헷갈리면 `show last`로 쟁점표와 쓸 수 있는 명령을 다시 본다.
