# Codex 단독 모드: Codex에게만 묻는 흐름

- 상태: 구현 완료 (1.1.0, 2026-10-29). dry-run과 실제 Codex CLI 한 차례 확인
- 범위: Codex 단독 모드. 다른 모드는 [manual-mode-flow.md](manual-mode-flow.md), [auto-mode-flow.md](auto-mode-flow.md), [compare-mode-flow.md](compare-mode-flow.md)를 따른다.
- 공통 규칙(파일 구성, 호출 실패, 저장·재개, dry-run)은 [common.md](common.md)를 따른다. 이 문서에는 이 모드에만 해당하는 규칙을 적는다.

## 목표

`claude` CLI 없이 사용자가 낸 질문·지시를 Codex에게만 보내 답을 받는다. 토의·합의·비교는 없다. 같은 토의 안에서 후속 질문을 이어 갈 수 있다.

## 역할

| 주체 | 맡는 일 |
|---|---|
| 사용자 | 시작 승인, 후속 질문, 종료 |
| 진행자 (토의를 호출한 Claude Code 세션) | 질문·배경 정리, Codex 답을 그대로 전함, 사용자의 말을 명령으로 옮김 |
| 스크립트 (discussion.mjs) | Codex 호출, 상태 저장, 로그 기록 |
| Codex (새 세션) | 질문에 답한다. 다른 AI가 있다는 것을 모른다 |

진행자 원칙:
- Codex 답을 요약·평가·보충하지 않는다.
- 다른 모드와 달리 그 차례의 raw 파일을 읽고 답 전문을 채팅에 그대로 옮긴다. 이 모드의 결과물이 Codex 답 자체이기 때문이다.

## 진행 흐름

```
0. 준비     진행자: 질문(지시)·배경·참조 정리 → [사용자: 시작 승인] → start
1. 답변 T1  Codex가 답한다 (JSON 없음)
2. 전달     진행자: raw를 읽고 답 전문과 링크를 보인다
3. 후속     사용자 후속 질문 → ask → 답변 T2 → 전달 … (반복)
4. 종료     end
```

## 구현

- 비교 모드의 단계(`answer`)·명령(`ask`, `next`, `end`, `show`)·state 구조를 그대로 쓰고, 참가자를 Codex 하나로 줄인다. 프롬프트도 비교 모드와 같다("아래 질문에 답하라", 후속 차례에는 이전 질문과 자기 이전 답).
- `start`는 PATH에서 `codex`만 확인한다. `claude`가 없어도 시작한다.
- `analysis`는 거부한다(비교할 답이 없다). `claude_model`은 쓰지 않으며 log.md 머리에 참가 Claude 모델을 적지 않는다.
- state는 비교 모드와 같고 `mode`만 `"codex"`다. `turns[].answers`에는 `codex`만 있다.

## 파일

- raw: `raw/t<N>_codex.md`
- log.md: 차례마다 질문과 Codex 답

## dry-run

- 비교 모드와 같은 가짜 응답(`(Codex) T1 답변`)을 쓴다. 시나리오는 `callfail`만 의미가 있다.
- 검증(2026-10-29): 시작 → 후속 질문 → 종료, 호출 실패로 중단 → `next` 재개, 거부 경로(`analysis`, 다른 모드 `--mode`), PATH에 CLI가 없을 때 `codex`만 요구하는지, 비교 모드가 그대로 동작하는지.
