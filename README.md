# ai-discussion 플러그인 (ai_discussion 브랜치)

Claude Code 플러그인입니다. 이 브랜치의 루트가 플러그인 루트이고, 마켓플레이스 목록(`marketplace.json`)은 main 브랜치에 있습니다.

## 플러그인

| 플러그인 | 스킬 | 내용 |
|---|---|---|
| `ai-discussion` | `/ai-discussion:judge` | Claude와 Codex가 쟁점별로 공방하고, 사용자가 쟁점마다 판정합니다. |
| | `/ai-discussion:consensus` | 한 AI가 초안을 쓰고 다른 AI가 검토하는 순차 토의로, 두 AI가 스스로 합의합니다. |
| | `/ai-discussion:start` | 모드 미정·이전 명령 호환용 입구. 모드를 정해 위 두 스킬로 넘깁니다. |

## 설치

Claude Code에서:

```
/plugin marketplace add rmia4/my_claude_skills
/plugin install ai-discussion@my-claude-skills
```

터미널에서:

```bash
claude plugin marketplace add rmia4/my_claude_skills
```

```bash
claude plugin install ai-discussion@my-claude-skills
```

설치한 뒤 Claude Code를 다시 시작하면 `/ai-discussion:judge`와 `/ai-discussion:consensus`를 쓸 수 있습니다. 모드를 정하지 않은 "Claude랑 Codex에게 토의시켜" 같은 말은 `/ai-discussion:start`가 받아 모드를 정한 뒤 넘깁니다.

## 필요한 것

- Node.js 18 이상 (`node` 명령). Codex CLI를 npm으로 설치했다면 이미 있습니다.
- `claude` CLI와 `codex` CLI (PATH에 있고 로그인된 상태)

## 사용 조건과 제약

### Claude Code에서만 쓸 수 있습니다

- 이 플러그인은 Claude Code(터미널 CLI, 데스크톱 앱의 Code 탭, IDE 확장)에서만 동작합니다.
- claude.ai 웹이나 데스크톱 앱의 Chat 탭에서는 쓸 수 없습니다. 거기에는 플러그인이 로드되지 않고, 코드가 클라우드 샌드박스에서 돌아서 내 컴퓨터의 `claude`·`codex` CLI를 부를 수 없습니다.

### CLI 연결과 모델은 터미널에서 직접 설정합니다

플러그인에는 CLI 연결이나 모델을 고르는 기능이 없습니다. 스크립트는 PATH에 있는 `claude`와 `codex`를 그대로 부릅니다. 그래서 각 CLI의 로그인 상태와 기본 모델을 그대로 씁니다.

| 항목 | 설정 방법 (터미널에서) |
|---|---|
| Claude 로그인 | `claude`를 실행해 로그인 |
| Claude 모델 | Claude Code 설정의 기본 모델 (`claude` 안에서 `/model`, 또는 `~/.claude/settings.json`의 `model`) |
| Codex 로그인 | `codex login` |
| Codex 모델 | `~/.codex/config.toml`의 `model` |

설치를 확인하려면 터미널에서 `claude --version`과 `codex --version`을 실행해 봅니다.

### 그 밖의 제약

- **기록 위치:** 토의 기록은 Claude Code 세션이 열린 폴더의 `discussions/<id>/`에 쌓입니다(state.json, log.md, raw/, final.md). 폴더를 따로 고를 수 없어서, 다른 폴더에서 세션을 열면 예전 토의를 `last`·`show`로 찾지 못합니다.
- **두 AI는 대화 맥락을 모릅니다:** 매 단계 새 세션으로 불립니다. 두 AI가 아는 것은 진행자가 spec에 적은 주제·배경·요구사항과 `context` 파일뿐입니다.
- **파일 접근:** spec에 `workdir`를 주면 두 AI가 그 폴더를 읽기 전용으로 참조합니다. Claude는 Read·Glob·Grep만, Codex는 read-only sandbox입니다. 두 AI 모두 파일을 고치지 않습니다.
- **외부 전송과 사용량:** 주제, 배경, `context` 파일 내용, `workdir`에서 읽은 파일은 Anthropic과 OpenAI로 전송됩니다. 사용량도 각 CLI에 로그인한 계정에서 나갑니다. 민감한 자료는 넣지 마세요.
- **시간:** AI 단계 하나에 보통 1~3분 걸립니다. 호출 하나의 제한 시간은 10분이고, 실패하면 2번까지 다시 시도합니다. 그래도 실패하면 토의가 중단 상태가 되고, `next`로 같은 단계를 다시 실행할 수 있습니다.
- **CLI 버전:** `claude -p`와 `codex exec`의 옵션에 맞춰 만들었습니다(확인한 버전: claude 2.1.300, codex-cli 0.163.0). CLI 옵션이 바뀌면 호출이 실패할 수 있습니다.
- **운영체제:** Windows에서만 확인했습니다. macOS·Linux에서는 아직 돌려 보지 않았습니다.

## 구조

```
.claude-plugin/plugin.json         플러그인 정보
skills/judge/SKILL.md              사용자 판정 토의 절차
skills/consensus/SKILL.md          자동 합의 토의 절차
skills/start/SKILL.md              모드를 정해 위 두 스킬로 넘기는 입구
scripts/discussion.mjs             AI 호출·상태 저장·규칙 적용 스크립트
docs/                              설계 문서
```

스킬은 `${CLAUDE_PLUGIN_ROOT}/scripts/discussion.mjs`로 스크립트를 부르므로, 설치 위치와 관계없이 동작합니다.
