# my-claude-skills 마켓플레이스 (ai_discussion 브랜치)

Claude Code 플러그인 마켓플레이스입니다.

## 플러그인

| 플러그인 | 스킬 | 내용 |
|---|---|---|
| `ai-discussion` | `/ai-discussion:toui` | Claude와 Codex가 한 주제를 함께 토의하게 합니다. 사용자가 쟁점마다 판정하는 모드와 두 AI가 스스로 합의하는 모드가 있습니다. |

## 설치

Claude Code에서:

```
/plugin marketplace add rmia4/my_claude_skills#ai_discussion
/plugin install ai-discussion@my-claude-skills
```

터미널에서:

```bash
claude plugin marketplace add rmia4/my_claude_skills#ai_discussion
```

```bash
claude plugin install ai-discussion@my-claude-skills
```

설치한 뒤 Claude Code를 다시 시작하면 `/ai-discussion:toui`를 쓸 수 있습니다. "Claude랑 Codex에게 토의시켜" 같은 말로도 불립니다.

## 필요한 것

- Python 3 (`python` 명령)
- `claude` CLI와 `codex` CLI (PATH에 있고 로그인된 상태)

## 사용

토의 기록은 스킬을 부른 **현재 작업 폴더**의 `discussions/<id>/`에 쌓입니다(state.json, log.md, raw/, final.md).

## 구조

```
.claude-plugin/marketplace.json      마켓플레이스 목록
plugins/ai-discussion/
  .claude-plugin/plugin.json         플러그인 정보
  skills/toui/SKILL.md               진행 절차 (스킬)
  scripts/discussion.py              AI 호출·상태 저장·규칙 적용 스크립트
  docs/                              설계 문서
```

스킬은 `${CLAUDE_PLUGIN_ROOT}/scripts/discussion.py`로 스크립트를 부르므로, 설치 위치와 관계없이 동작합니다.
