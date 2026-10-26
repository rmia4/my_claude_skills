---
name: start
description: Claude와 Codex 두 AI의 토의를 시작하거나 이어 가는 입구. 판정 방식이 정해지지 않은 요청을 받아 사용자 판정(/ai-discussion:judge)이나 자동 합의(/ai-discussion:consensus) 스킬로 넘긴다. 사용자가 "/ai-discussion:start", "토의", "두 AI에게 토의시켜", "Claude랑 Codex 의견 비교", "토의 이어서" 같은 말을 할 때 쓴다.
---

# /ai-discussion:start — 토의 입구

이 스킬은 절차를 담지 않는다. 모드를 정해 맞는 스킬로 넘기는 일만 한다.

## 새 토의

1. 사용자 말에서 모드가 분명하면 바로 정한다.
   - 사용자가 쟁점마다 결정하려 하면 `judge`
   - AI끼리 합의시키려 하면 `consensus`
2. 분명하지 않으면 사용자에게 묻는다: "쟁점마다 직접 판정할까요(judge), 두 AI가 스스로 합의하게 할까요(consensus)?"
3. Skill 도구로 `ai-discussion:judge` 또는 `ai-discussion:consensus`를 부른다. args에는 이미 받은 주제·배경·요구사항·참조 파일·작업 폴더를 줄이지 않고 그대로 넣고, 끝에 `via=start`를 붙인다.

## 진행 중인 토의 이어 가기

1. 대상은 사용자가 지정한 토의 이름, 지정이 없으면 `last`다.
2. 스크립트 `${CLAUDE_PLUGIN_ROOT}/scripts/discussion.mjs`로 `node "<스크립트>" show <id>`를 실행해(`--mode` 없이) 첫 줄의 모드를 확인한다. 경로가 채워지지 않았으면 `~/.claude/plugins/cache` 아래에서 `**/ai-discussion/**/scripts/discussion.mjs`를 찾는다.
3. 그 모드의 스킬을 Skill 도구로 부르고, args에 토의 이름과 `via=start`를 넣는다.

## 하지 않는 일

- 주제·배경 정리, 시작 승인, spec 작성, 스크립트의 `start`·`next` 실행은 하지 않는다. 모두 모드 스킬이 맡는다.
- Skill 호출이 실패할 때만 `/ai-discussion:judge` 또는 `/ai-discussion:consensus`를 입력하라고 안내한다. 이때 대화에 남은 입력을 다시 받지 않는다.
