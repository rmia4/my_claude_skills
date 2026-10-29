---
name: start
description: Claude와 Codex 두 AI의 토의를 시작하거나 이어 가는 입구. 모드가 정해지지 않은 요청을 받아 수동 모드(/ai-discussion:manual), 자동 모드(/ai-discussion:auto), 비교 모드(/ai-discussion:compare), Codex 단독 모드(/ai-discussion:codex) 스킬로 넘긴다. 사용자가 "/ai-discussion:start", "토의", "두 AI에게 토의시켜", "Claude랑 Codex 의견 비교", "토의 이어서" 같은 말을 할 때 쓴다.
---

# /ai-discussion:start — 토의 입구

이 스킬은 절차를 담지 않는다. 모드를 정해 맞는 스킬로 넘기는 일만 한다.

## 새 토의

1. 사용자 말에서 모드가 분명하면 바로 정한다.
   - 사용자가 쟁점마다 결정하려 하면 `manual`
   - AI끼리 합의시키려 하면 `auto`
   - 합의 없이 두 AI의 답을 따로 받아 비교만 하려 하면 `compare`
   - Claude 없이 Codex에게만 물으려 하면 `codex`
2. 분명하지 않으면 두 모드의 차이를 설명하고 고르게 한다. 아래 문구를 그대로 보인다.

   > 토의 모드를 골라 주세요.
   > - **수동 모드**: 두 AI가 각자 답한 뒤 쟁점별로 공방하고, 쟁점마다 결론은 사용자가 직접 판정합니다. 진행 중에 쟁점표를 보며 판정·보류·제외·요구사항 추가를 할 수 있습니다. 결론을 직접 고르고 싶을 때 맞습니다.
   > - **자동 모드**: 한 AI가 초안을 쓰고 다른 AI가 검토·수정하는 과정을 되풀이해 두 AI가 스스로 합의안을 만듭니다. 사용자는 시작만 승인하고 끝난 결과를 받습니다. 맡겨 두고 결과만 받고 싶을 때 맞습니다.
   > - **비교 모드**: 두 AI가 서로의 답을 보지 않고 따로 답하고, 진행자가 요약·공통점·차이점을 정리합니다. 합의나 판정은 하지 않으며 후속 질문을 이어 갈 수 있습니다. 각 AI의 의견만 듣고 싶을 때 맞습니다.

   AskUserQuestion을 쓰면 위 설명을 각 선택지의 description에 넣는다(질문 앞 본문은 사용자에게 보이지 않을 수 있다).
3. Skill 도구로 `ai-discussion:manual`, `ai-discussion:auto`, `ai-discussion:compare`, `ai-discussion:codex` 중 하나를 부른다. args에는 이미 받은 주제·배경·요구사항·참조 파일·작업 폴더를 줄이지 않고 그대로 넣고, 끝에 `via=start`를 붙인다.

## 진행 중인 토의 이어 가기

1. 대상은 사용자가 지정한 토의 이름, 지정이 없으면 `last`다.
2. 스크립트 `${CLAUDE_PLUGIN_ROOT}/scripts/discussion.mjs`로 `node "<스크립트>" show <id>`를 실행해(`--mode` 없이) 첫 줄의 모드를 확인한다. 경로가 채워지지 않았으면 `~/.claude/plugins/cache` 아래에서 `**/ai-discussion/**/scripts/discussion.mjs`를 찾는다.
3. 그 모드의 스킬을 Skill 도구로 부르고, args에 토의 이름과 `via=start`를 넣는다.

## 하지 않는 일

- 주제·배경 정리, 시작 승인, spec 작성, 스크립트의 `start`·`next` 실행은 하지 않는다. 모두 모드 스킬이 맡는다.
- Skill 호출이 실패할 때만 `/ai-discussion:manual`, `/ai-discussion:auto`, `/ai-discussion:compare`, `/ai-discussion:codex` 중 맞는 것을 입력하라고 안내한다. 이때 대화에 남은 입력을 다시 받지 않는다.
