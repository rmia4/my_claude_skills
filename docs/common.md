# 공통 규칙 (두 모드 공용)

- 상태: 계획 확정, 미구현 (2026-10-26)
- 적용: [manual-mode-flow.md](manual-mode-flow.md)(수동 모드), [auto-mode-flow.md](auto-mode-flow.md)(자동 모드)
- 이 문서의 규칙은 두 모드에 똑같이 적용한다. 모드마다 다른 규칙은 각 모드 문서에만 적는다. 한 모드 문서의 규칙을 다른 모드에 가져다 쓰지 않는다.

## 원칙

- 두 AI는 새 세션으로 대등하게 호출한다(`claude -p`, `codex exec`).

## 호출 방식

- 참가 Claude는 `--strict-mcp-config --disable-slash-commands --setting-sources project`로 부르고, 모델을 지정했으면 `--model <모델>`을 더한다. 사용자 MCP·스킬·user/local 설정(훅 등)을 싣지 않아 고정 문맥을 줄인다. 사용자 `~/.claude/CLAUDE.md`는 이 옵션으로 빠지지 않는다(`--bare`는 API 키 인증만 받아 쓰지 않는다).
- 모델은 spec의 `claude_model`이다. 없으면 `--model`을 넘기지 않아 CLI 기본 모델을 쓴다. user 설정을 읽지 않으므로 `/model`이나 `~/.claude/settings.json`의 `model`은 따르지 않는다. state와 log.md 머리에 남긴다(지정하지 않았으면 "CLI 기본값").
- 도구: workdir가 있으면 `--tools "Read,Glob,Grep"`, 없으면 `--tools ""`(도구 정의를 싣지 않는다).
- Codex는 사용자 설정을 그대로 쓴다(`--ignore-user-config`·`--ignore-rules`를 쓰지 않는다. config.toml의 developer_instructions 유지).
- Codex는 토의에 쓰지 않는 기능을 끄고 부른다: `--disable apps --disable plugins --disable multi_agent --disable image_generation --disable browser_use --disable computer_use --disable goals --disable tool_suggest`. 고정 문맥이 약 16.8k에서 12.8k로 준다. 안전 규칙(developer_instructions)·사용자 AGENTS.md·권한 안내·훅은 남는다.
  - 설치된 codex가 모르는 기능 이름이나 `--disable` 자체를 거부해 모델 실행 전에 인자 오류(`Unknown feature flag`, `unexpected argument '--disable'`)로 끝나면, 그 실행 동안은 `--disable` 없이 한 번 다시 부른다. 일반 실행 오류나 응답 실패는 이 경로를 타지 않고 [호출 실패](#호출-실패)의 재시도를 따른다.
- workdir가 있을 때 두 AI의 header에 같은 파일 읽기 원칙을 준다: 코드를 수정하지 않는 토의임, 참조 자료로 충분하면 읽지 않음, 부족하면 확인할 사실을 정하고 위치를 찾은 뒤 필요한 줄 범위부터 읽음, 통째 읽기·재읽기 금지, 문맥이 부족하면 인접 범위를 더 확인(고정 상한 없음), 근거의 경로·줄 범위 명시, 파일 수정·생성 금지. 위치 찾기·줄 범위 읽기 방법만 참가자별로 다르다(Codex: `rg -n`, `Get-Content`와 `Select-Object -Skip/-First`. Claude: Grep으로 위치 확인 후 Read의 offset/limit).
- workdir가 없을 때 최종 검토 성격의 프롬프트(수동 모드 최종안 검토, 자동 모드 정리본)에는 "이 작업은 코드를 수정하지 않는 토의다"를 밝혀 토의와 무관한 스킬 읽기를 줄인다. workdir가 있으면 header에 같은 문장이 있다. 스킬을 무시하라는 지시는 넣지 않는다.
- 작업 폴더: workdir가 있으면 그 폴더, 없으면 단계마다 빈 임시 폴더를 만들어 두 CLI를 거기서 실행하고 단계가 끝나면 지운다. 진행자 프로젝트의 CLAUDE.md·AGENTS.md가 실리지 않게 하기 위해서다.
  - 측정 실험용으로 spec에 `"fixed_empty_dir": true`를 주면 임시 폴더 경로를 토의마다 하나(`<임시 폴더>/ai-discussion-<토의 이름>`)로 고정한다. 단계마다 비운 채로 다시 만들고 단계가 끝나면 지우므로 늘 비어 있다. 첫 요청의 캐시 적중이 높아지는지 비교하기 위한 것이며 기본은 끈다.
- 스크립트는 절차만 처리한다. 근거의 질이나 주장의 반복 여부 같은 의미 판단은 하지 않는다.
- 진행자는 AI 응답을 원문 그대로 보여 준다. 요약이나 평가는 하지 않는다.

## 파일 구성

```
discussions/.gitignore      `*` 한 줄. 폴더를 처음 만들 때 생성해 git에서 제외한다 (이미 있으면 두기)
discussions/20261026-1030_주제/
  ├ state.json        현재 상태 (스크립트만 씀)
  ├ log.md            사람이 읽는 전체 기록
  └ raw/              호출마다 AI 응답 원문 (시도별로 따로 저장)
      ├ r1_claude.md, r1_codex.md
      ├ r2_review_codex.md
      ├ r2_review_codex.try2.md     ← 재시도한 응답
      ├ usage.jsonl                 ← 호출마다 토큰 사용량 한 줄 (spec usage가 true일 때만)
      └ ...
```

- 원문은 `raw/` 파일 링크로 보여 준다(아래 "원문 표시 범위"). 스크립트는 원문 경로를 작업 폴더 기준(`discussions/<id>/raw/...`)으로 출력한다.
- 토의 이름은 `YYYYMMDD-HHMM_슬러그`다. 슬러그는 spec의 `name`, 없으면 주제 앞 10자다. 명령의 `<id>`에는 토의 이름, `last`(가장 최근 토의), 이름 앞부분(하나만 맞을 때)을 쓸 수 있다.
- state.json에는 모드별 필드 외에 다음 공통 필드를 둔다.
  - `status`: `running` / `halted`(중단·오류) / `done`
  - `pending_step`: 다음에 실행할 단계
  - `halt_reason`: 중단 사유 (`halted`일 때)

## 모드 확인

- 새 spec에는 `mode`가 필수다. 없으면 `start`가 spec 예시와 함께 거부한다. 0.2.x에서 mode 없이 저장된 state는 `auto`로 읽고, 0.4.x 이전 이름(`judge`·`consensus`)으로 저장된 state는 `manual`·`auto`로 읽는다.
- 토의를 여는 모든 명령은 `--mode manual|auto`를 받는다. 주면 `last`나 지정 id를 실제 토의로 찾은 뒤 state의 mode와 비교하고, 다르면 거부하며 맞는 스킬(`/ai-discussion:<mode>`)을 알려 준다. `start` 명령도 `--mode`를 받으며, spec의 mode와 다르면 거부한다. 모드 스킬은 항상 붙이고, `start` 스킬은 재개할 모드를 알아낼 때만 빼고 `show`를 부른다.
- spec의 `via`(예: `"start"`)는 state에 그대로 남긴다. `start` 스킬의 사용 비율을 보고 제거 여부를 판단하는 데 쓴다.
- `start`는 `claude`·`codex` CLI가 PATH에 없으면 시작하지 않는다(dry-run 제외).

## 응답 파싱

- AI는 본문을 자유롭게 쓰고 끝에 ```` ```json ```` 블록을 붙인다. JSON이 필요 없는 단계도 있으며, 어느 단계인지는 각 모드 문서에 정한다.
- 스크립트는 응답에서 **마지막** ```` ```json ```` 블록을 읽는다. 본문은 그 블록 앞부분 전체다. 본문 안에 JSON 예시가 있어도 마지막 블록만 읽으므로 문제가 없다.
- 블록 뒤에 붙은 글은 무시하고 raw 파일에만 남긴다.
- 다음은 형식 오류다.
  - JSON 블록이 필요한 단계인데 블록이 없거나 읽을 수 없음
  - 필수 필드가 없거나, 값이 정해진 목록 밖에 있음
  - 필수 문자열 필드(근거, 사유 등)가 비어 있음. 내용이 충분한지는 검사하지 않는다.
  - 각 모드 문서가 정한 ID·개수·조합 규칙 위반
- 사용자에게는 JSON 블록을 뺀 본문을 보여 준다.

## 형식 오류 재시도

- 형식 오류가 나면 그 AI만 한 번 더 부른다. 프롬프트는 "본문은 그대로 두고 JSON 블록만 다시 써라"이며, 오류 내용을 함께 준다.
- 재시도 프롬프트는 원래 프롬프트(첫 호출과 같은 접두부) + 직전 응답의 마지막 JSON 블록 + 오류 내용이다. 직전 응답에 JSON 블록이 없으면 응답 전체를 붙인다(본문에서 JSON을 만들어야 하므로).
- 재시도에서는 JSON 블록만 새로 받고, 본문은 첫 응답의 것을 쓴다. 초안처럼 본문이 결과물인 경우가 바뀌지 않게 하기 위해서다.
- 재시도도 실패했을 때의 처리는 모드마다 다르다. 각 모드 문서를 따른다.

## 호출 실패

- 호출 한 번의 제한 시간은 600초다.
- 시간 초과, 실행 오류(종료 코드 ≠ 0), 빈 응답은 호출 실패다. 최대 2번 다시 시도한다.
- 다시 시도하기 전에 10초, 30초를 기다린다(모델 용량 부족 같은 일시 오류). dry-run에서는 기다리지 않는다.
- 실패 메시지는 stderr에서 `ERROR`로 시작하는 줄(없으면 마지막 3줄)만 보인다. 재시도를 다 쓰고 멈추면 마지막 시도의 stderr 전체를 `raw/<tag>_<who>.stderr.txt`에 저장한다.
- 재시도를 다 쓰고도 실패하면 `status: halted`로 멈추고 `halt_reason`에 사유를 남긴다.

## 토큰 사용량 기록

- 기본은 끈다. spec에 `"usage": true`를 줄 때만 아래처럼 기록하고 상태 출력에 보인다. 사용자가 토큰 사용량을 알려 달라고 할 때만 넣는다.
- Claude는 `--output-format json`으로 불러 `result`를 본문으로, `usage`·`modelUsage`·`total_cost_usd`를 사용량으로 읽는다. JSON을 읽을 수 없으면 stdout 전체를 본문으로 쓰고 사용량은 비운다. `is_error`면 `result`를 오류 메시지로 쓴다.
- Codex는 `--json`으로 불러 stdout JSONL의 `turn.completed` usage를 더한다. 본문은 지금처럼 `--output-last-message` 파일에서 읽는다.
- 응답을 받은 시도마다 `raw/usage.jsonl`에 한 줄을 쓴다: `{tag, who, attempt, model, input, cache_read, cache_write, output, thinking, cost_usd, ms}`.
  - `input`은 캐시 읽기·쓰기를 포함한 전체 입력이다. Claude는 `input_tokens + cache_read + cache_creation`, Codex는 `input_tokens`(캐시 읽기 포함)다.
  - `thinking`은 `output`에 포함된 생각 토큰이다(Claude `output_tokens_details.thinking_tokens`, Codex `reasoning_output_tokens`).
  - Codex의 `model`과 `cost_usd`는 출력에 없어 null이다. Claude의 `cost_usd`는 API 정가 기준이라 구독 한도와 같지 않다.
  - dry-run은 사용량 필드를 null로 쓴다.
- 상태 출력(`show`, `next`, `run`)에 지금까지의 양측 합계(호출 수, 입력, 캐시 읽기, 출력)를 한 줄로 보인다.

## 저장 시점과 재개

- raw 파일은 시도할 때마다 바로 저장한다.
- state.json은 한 단계의 응답을 모두 받아 파싱과 검사를 마친 **뒤에만** 바꾼다. 중간에 멈춰도 상태가 반쯤 바뀐 채로 남지 않는다.
- 두 AI를 동시에 부르는 단계는 둘 다 성공해야 state.json을 바꾼다.
- `next`는 `pending_step`을 실행한다. 단계가 실패하거나 사용자가 취소한 뒤 `next`를 다시 부르면, 그 단계를 처음부터 다시 실행한다. 이미 끝난 단계는 다시 실행하지 않는다.
- `halted` 상태에서 `next`를 부르면 `running`으로 되돌리고 `pending_step`을 다시 실행한다.
- 자동 모드의 `run`은 `next`를 종료나 중단까지 되풀이한다. `halted` 상태에서 부르면 그 단계부터 다시 실행한다.

## 원문 표시 범위

- 진행자는 AI 본문을 채팅에 옮기지 않는다. 각 단계에서 **채택된 시도**의 raw 파일을 링크로 남겨, 사용자가 원할 때 바로 열어 보게 한다.
- 채팅에는 스크립트가 출력한 상태(쟁점표·지적 목록과 처리 결과)를 보인다. 그 안의 입장·반박·지적 문장은 AI가 JSON에 쓴 문장 그대로이므로 요약이 아니다.
- 재시도 전 응답과 실패한 응답은 raw에만 남기고 링크하지 않는다.
- `halted`일 때는 중단된 단계, 오류 내용, 재개 방법(수동 모드는 `next <id>`, 자동 모드는 `run <id>`)을 보여 준다.

## dry-run

- `--dry-run`은 CLI를 호출하지 않고 단계별로 정해진 형식의 가짜 응답을 만든다.
- 각 모드의 규칙을 시험할 수 있도록 철회, 교착, 형식 오류, 호출 실패 같은 경우도 일부러 만든다.
