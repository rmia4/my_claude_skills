#!/usr/bin/env python3
"""Claude(Claude Code) + Codex(Codex CLI) 토의 진행 스크립트 (개인용)

설계 문서: docs/common.md, docs/consensus-mode-flow.md, docs/judge-mode-flow.md

명령
  start --spec spec.json   토의를 만들고 첫 단계(R1)를 실행한다
  next <id>                다음 단계를 실행한다 (중단된 단계는 다시 실행)
  show <id>                현재 상태와 결과를 출력한다
  사용자 판정 모드 전용: edit, judge, judge-all, note, req, defer, exclude, pick-wording,
                        proposal, reopen, final-draft, final, final-fix, confirm, end (-h로 사용법 확인)
  <id>에는 토의 이름, last(가장 최근 토의), 이름 앞부분을 쓸 수 있다

spec.json 예 (mode: "consensus" 또는 "judge")
  {"mode": "consensus", "topic": "...", "background": "...",
   "requirements": ["..."], "context": ["배경.md"], "workdir": "C:/dev/myproject",
   "max_rounds": 5}

사용 예
  python debate.py start --spec spec.json
  python debate.py next 20261026-103000_주제
  python debate.py start --spec spec.json --dry-run --scenario stall   # CLI 없이 규칙 시험
"""
import argparse
import copy
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

# ── CLI 실행 설정 (설치된 버전에 맞게 조정) ────────────────────────────
CLAUDE_CMD = ["claude", "-p", "--output-format", "text"]   # 프롬프트는 stdin으로 전달
CODEX_CMD = ["codex", "exec", "--skip-git-repo-check", "--sandbox", "read-only"]
TIMEOUT_SEC = 600
WORKDIR = None   # --workdir 지정 시 두 AI가 이 폴더의 파일을 읽기 전용으로 참조
RETRIES = 2

NAMES = {"claude": "Claude", "codex": "Codex"}
OTHER = {"claude": "codex", "codex": "claude"}


# ── AI 호출 ──────────────────────────────────────────────────────────
def call_claude(prompt: str) -> str:
    cmd = CLAUDE_CMD + (["--allowedTools", "Read,Glob,Grep"] if WORKDIR else [])
    r = subprocess.run(cmd, input=prompt, capture_output=True, cwd=WORKDIR,
                       text=True, encoding="utf-8", timeout=TIMEOUT_SEC)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or f"exit {r.returncode}")
    return r.stdout.strip()


def call_codex(prompt: str) -> str:
    # 진행 로그와 섞이지 않도록 최종 답변만 파일로 받는다
    fd, out = tempfile.mkstemp(suffix=".txt")
    os.close(fd)
    try:
        # Windows의 codex는 npm이 만든 codex.cmd라 이름만으로는 실행되지 않아 전체 경로를 찾는다
        exe = shutil.which(CODEX_CMD[0]) or CODEX_CMD[0]
        cmd = [exe] + CODEX_CMD[1:] + (["--cd", WORKDIR] if WORKDIR else [])
        r = subprocess.run(cmd + ["--output-last-message", out, "-"],
                           input=prompt, capture_output=True,
                           text=True, encoding="utf-8", timeout=TIMEOUT_SEC)
        if r.returncode != 0:
            raise RuntimeError(r.stderr.strip()[-2000:] or f"exit {r.returncode}")
        return Path(out).read_text(encoding="utf-8").strip()
    finally:
        Path(out).unlink(missing_ok=True)


def ask(who: str, prompt: str, fake=None) -> str:
    """fake: --dry-run 용 가짜 호출 함수. 실제 호출과 같은 재시도를 거친다"""
    fn = fake or (call_claude if who == "claude" else call_codex)
    last = None
    for _ in range(RETRIES + 1):
        try:
            out = fn(prompt)
            if not out.strip():
                raise RuntimeError("빈 응답")
            return out
        except Exception as e:  # 시간 초과·실행 오류·빈 응답은 재시도
            last = e
            print(f"  ! {NAMES[who]} 호출 실패, 재시도: {e}", file=sys.stderr)
    raise RuntimeError(f"{NAMES[who]} 호출이 계속 실패했습니다: {last}")


# ── 공통: 상태·파싱·재시도 (docs/common.md) ──────────────────────────
DEBATES = Path("debates")   # 호출한 프로젝트 폴더에 쌓는다


class FormatError(Exception):
    pass


class Halt(Exception):
    pass


JSON_BLOCK_RE = re.compile(r"```json[ \t]*\n(.*?)```", re.S)
JSON_TAIL = "\n응답 맨 끝에 아래 형식의 ```json 코드 블록을 하나 붙여라.\n"


def split_json(text, needs_json):
    """(본문, 데이터, 오류). 마지막 ```json 블록만 읽고, 그 앞부분 전체를 본문으로 본다"""
    if not needs_json:
        return text.strip(), None, None
    blocks = list(JSON_BLOCK_RE.finditer(text))
    if not blocks:
        return text.strip(), None, "```json 블록이 없습니다"
    m = blocks[-1]
    body = text[:m.start()].strip()
    try:
        data = json.loads(m.group(1))
    except json.JSONDecodeError as e:
        return body, None, f"JSON을 읽을 수 없습니다: {e}"
    if not isinstance(data, dict):
        return body, None, "JSON 최상위는 객체여야 합니다"
    return body, data, None


def need_str(obj, key, where):
    v = obj.get(key)
    if not isinstance(v, str) or not v.strip():
        raise FormatError(f"{where}: '{key}'가 비어 있습니다")
    return v.strip()


def bullets(items):
    return "".join(f"- {x}\n" for x in items)


def debate_dir(id_):
    """경로, 토의 이름, last(가장 최근 토의), 이름 앞부분(하나만 맞을 때)을 받는다"""
    for d in (Path(id_), DEBATES / id_):
        if (d / "state.json").exists():
            return d
    found = sorted(p for p in DEBATES.glob("*") if (p / "state.json").exists())
    if id_ == "last" and found:
        return found[-1]   # 이름이 시작 시각으로 시작하므로 이름순 마지막이 가장 최근이다
    hits = [p for p in found if p.name.startswith(id_)]
    if len(hits) == 1:
        return hits[0]
    if hits:
        sys.exit(f"여러 토의가 맞습니다: {', '.join(p.name for p in hits)}")
    sys.exit(f"토의를 찾을 수 없습니다: {id_}")


def load(d):
    return json.loads((d / "state.json").read_text(encoding="utf-8"))


def save(d, st):
    tmp = d / "state.json.tmp"
    tmp.write_text(json.dumps(st, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(d / "state.json")


def append_log(d, text):
    with (d / "log.md").open("a", encoding="utf-8") as f:
        f.write(text + "\n")


RAW_WRITTEN = []   # 이번 실행에서 저장한 raw 파일 (상태 출력용)


def call_step(st, d, who, tag, prompt, needs_json, validate, lenient=None):
    """AI 한 번 호출 → 원문 저장 → 파싱·검사. 형식 오류는 JSON만 한 번 다시 받는다.
    lenient가 있으면 재시도도 실패했을 때 멈추지 않고 lenient(본문, 읽은 JSON 또는 None, 오류)를 돌려준다"""
    def once(p, attempt):
        fake_fn = fake_consensus if st["mode"] == "consensus" else fake_judge
        fake = (lambda _: fake_fn(st, tag, who, attempt)) if st["dry_run"] else None
        try:
            text = ask(who, p, fake)
        except RuntimeError as e:
            raise Halt(str(e))
        name = f"{tag}_{who}" + (f".try{attempt}" if attempt > 1 else "") + ".md"
        (d / "raw" / name).write_text(text, encoding="utf-8")
        RAW_WRITTEN.append((d / "raw" / name).as_posix())   # 진행자가 그대로 링크를 걸 수 있는 경로
        return text

    text = once(prompt, 1)
    body, data, err = split_json(text, needs_json)
    first = data
    if not err:
        try:
            return validate(body, data)
        except FormatError as e:
            err = str(e)
    retry = (f"{prompt}\n\n[너의 직전 응답]\n{text}\n\n[형식 오류]\n{err}\n"
             "본문은 다시 쓰지 말고, 오류를 고친 ```json 블록 하나만 출력하라.")
    _, data, err = split_json(once(retry, 2), True)
    if not err:
        try:
            return validate(body, data)   # 본문은 첫 응답의 것을 쓴다
        except FormatError as e:
            err = str(e)
    if lenient:
        return lenient(body, data if data is not None else first, err)
    raise Halt(f"{NAMES[who]} 응답 형식 오류 (재시도 후): {err}")


# ── 자동 합의 모드 (docs/consensus-mode-flow.md) ──────────────────────
STEP_KO = {"r1": "R1 독립 답변", "draft": "통합 초안", "review": "검토", "revise": "수정"}
HOW_KO = {"applied": "반영", "modified": "고쳐 반영", "withdrawn": "철회"}

REVIEW_JSON = """```json
{"points": [
  {"id": null, "action": "new", "problem": "...", "grounds": "...", "criterion": "해당 판단 기준",
   "replacement": {"target": "바꿀 부분 인용", "text": "대체 문안"}},
  {"id": "P2", "action": "keep", "grounds": "..."},
  {"id": "P3", "action": "withdraw", "grounds": "..."},
  {"id": "P4", "action": "confirm"}
], "approve": false}
```
- 새 지적은 id를 null로 둔다. replacement는 필요할 때만 쓴다.
"""

REVISE_JSON = """```json
{"responses": [
  {"id": "P1", "reply": "accept", "applied": "as_is"},
  {"id": "P2", "reply": "accept", "applied": "modified", "reason": "..."},
  {"id": "P3", "reply": "rebut", "grounds": "..."}
]}
```
"""


def header(st, who):
    tools = ("작업 폴더의 파일은 읽기 도구로 자유롭게 참조하되, 어떤 파일도 수정·생성하지 마라. "
             "근거로 쓴 파일은 경로를 밝혀라. " if st["workdir"] else "도구나 파일을 쓰지 마라. ")
    s = (f"너는 {NAMES[who]}이다. 다른 AI인 {NAMES[OTHER[who]]}와 아래 주제를 함께 토의해 결론을 찾는다. "
         f"{tools}최종 출력에는 응답만 내라. 한국어로 답하라.\n\n[주제]\n{st['topic']}\n")
    if st["background"]:
        s += f"\n[배경]\n{st['background']}\n"
    if st["requirements"]:
        # 판정 모드는 요구사항을 {"id", "text", "round"}로 저장한다
        s += "\n[요구사항]\n" + bullets(r["text"] if isinstance(r, dict) else r for r in st["requirements"])
    if st["context"]:
        s += f"\n[참조 자료]\n{st['context']}\n"
    return s


def last_by(p, who):
    return next((h for h in reversed(p["history"]) if h["who"] == who), None)


def point_text(pid, p, extra=""):
    s = f"- {pid}: {p['problem']}\n  근거: {p['grounds']}\n"
    if p["criterion"]:
        s += f"  판단 기준: {p['criterion']}\n"
    if p["replacement"]:
        s += (f"  대체 문안 (대상: {p['replacement'].get('target', '')})\n"
              f"  {p['replacement'].get('text', '')}\n")
    return s + extra


def unresolved(st):
    return [pid for pid, p in st["points"].items() if p["status"] != "closed"]


def new_cap(st):
    if st["round"] == 1:
        return 5
    return 0 if st["round"] >= st["max_rounds"] else 2


def step_r1(st, d):
    prompts = {w: header(st, w) + "\n[1단계: 독립 답변]\n상대 답을 보지 않은 상태에서 너의 답을 제시하라. "
                  "답을 정할 때 쓴 판단 기준도 정리하라.\n" + JSON_TAIL +
                  '```json\n{"criteria": ["판단 기준", "..."]}\n```\n'
               for w in NAMES}

    def validate(body, data):
        c = data.get("criteria")
        if not isinstance(c, list) or not c or not all(isinstance(x, str) and x.strip() for x in c):
            raise FormatError("'criteria'는 비어 있지 않은 문자열 목록이어야 합니다")
        return body, [x.strip() for x in c]

    with ThreadPoolExecutor(max_workers=2) as ex:   # 둘 다 성공해야 상태를 바꾼다
        futs = {w: ex.submit(call_step, st, d, w, "r1", prompts[w], True, validate) for w in NAMES}
        res = {w: f.result() for w, f in futs.items()}
    st["r1"] = {w: res[w][0] for w in NAMES}
    st["criteria"] = {w: res[w][1] for w in NAMES}
    for w in NAMES:
        append_log(d, f"\n## R1 · {NAMES[w]}\n\n{st['r1'][w]}\n\n판단 기준:\n{bullets(st['criteria'][w])}")
    st["pending_step"] = "draft"
    return st


def step_draft(st, d):
    x, y = st["author"], OTHER[st["author"]]
    prompt = (header(st, x) + "\n[2단계: 통합 초안]\n너는 작성자다. 아래 두 독립 답변을 대등하게 검토해 "
              f"하나의 통합 초안을 써라. 이후 {NAMES[y]}가 이 초안을 검토하고 지적한다.\n"
              "초안 첫머리에 '## 판단 기준' 절을 두고 양측 판단 기준을 합친 목록을 적어라. "
              "기준을 빼거나 합쳤다면 그 이유를 함께 적어라.\n응답에는 초안 본문만 써라.\n\n"
              f"[너의 독립 답변]\n{st['r1'][x]}\n\n[너의 판단 기준]\n{bullets(st['criteria'][x])}\n"
              f"[{NAMES[y]}의 독립 답변]\n{st['r1'][y]}\n\n"
              f"[{NAMES[y]}의 판단 기준]\n{bullets(st['criteria'][y])}")
    st["draft"] = call_step(st, d, x, "draft", prompt, False, lambda body, _: body)
    st["draft_version"], st["round"], st["pending_step"] = 1, 1, "review"
    append_log(d, f"\n## 초안 v1 · {NAMES[x]}\n\n{st['draft']}")
    return st


def step_review(st, d):
    x, y = st["author"], OTHER[st["author"]]
    rnd, cap = st["round"], new_cap(st)
    awaiting = [pid for pid, p in st["points"].items() if p["status"] in ("accepted", "rebutted")]

    s = (header(st, y) + f"\n[검토 · 라운드 {rnd}/{st['max_rounds']}]\n너는 검토자다. "
         f"작성자 {NAMES[x]}가 쓴 초안을 판단 기준에 비춰 검토하라.\n"
         f"\n[너의 독립 답변]\n{st['r1'][y]}\n\n[너의 판단 기준]\n{bullets(st['criteria'][y])}"
         f"\n[{NAMES[x]}의 판단 기준]\n{bullets(st['criteria'][x])}"
         f"\n[현재 초안 v{st['draft_version']}]\n{st['draft']}\n")
    if rnd == 1:
        s += "\n초안의 판단 기준 처리(제외·병합)에 이의가 있으면 그것도 지적으로 올려라.\n"
    if awaiting:
        s += "\n[응답할 지적] 아래 지적마다 정확히 한 번씩 응답하라.\n"
        for pid in awaiting:
            p, h = st["points"][pid], last_by(st["points"][pid], x)
            kind = "수용" if p["status"] == "accepted" else "반박"
            s += point_text(pid, p, f"  {NAMES[x]}의 응답: {kind}" + (f" — {h['text']}" if h["text"] else "") + "\n")
        s += (f"- {NAMES[x]}가 수용한 지적: 초안에 맞게 반영됐으면 confirm, 반영이 부족하면 keep(근거 필수)\n"
              f"- {NAMES[x]}가 반박한 지적: 반박을 받아들이면 withdraw(어떤 근거로 철회하는지 필수), "
              "아니면 keep(재반박 필수)\n쉽게 철회하지 말고, 근거가 충분할 때만 철회하라.\n")
    s += (f"\n새 지적은 최대 {cap}개까지 낼 수 있다. 새 지적에는 문제, 근거, 해당 판단 기준을 적고, "
          "필요하면 대체 문안을 제시하라.\n" if cap else "\n이번이 마지막 라운드이므로 새 지적은 낼 수 없다.\n")
    s += "남은 지적이 없고 새 지적도 없을 때만 approve를 true로 하라.\n" + JSON_TAIL + REVIEW_JSON

    def validate(body, data):
        new = copy.deepcopy(st)
        pts = data.get("points")
        if not isinstance(pts, list) or not isinstance(data.get("approve"), bool):
            raise FormatError("'points'(목록)와 'approve'(true/false)가 필요합니다")
        seen, added = set(), 0
        for i, p in enumerate(pts):
            if not isinstance(p, dict):
                raise FormatError(f"points[{i}]가 객체가 아닙니다")
            act = p.get("action")
            if act == "new":
                added += 1
                where = f"새 지적 {added}"
                problem, grounds = need_str(p, "problem", where), need_str(p, "grounds", where)
                rep = p.get("replacement")
                pid = f"P{new['next_point']}"
                new["next_point"] += 1
                new["points"][pid] = {
                    "problem": problem, "grounds": grounds,
                    "criterion": p.get("criterion") if isinstance(p.get("criterion"), str) else "",
                    "replacement": rep if isinstance(rep, dict) and rep.get("text") else None,
                    "status": "open", "closed_how": None, "clash": 0,
                    "history": [{"round": rnd, "who": y, "action": "new", "text": grounds}]}
                continue
            pid = p.get("id")
            cur = new["points"].get(pid) if isinstance(pid, str) else None
            if cur is None or cur["status"] == "closed":
                raise FormatError(f"{pid}: 없는 지적이거나 이미 종료된 지적입니다")
            if pid in seen:
                raise FormatError(f"{pid}: 두 번 응답했습니다")
            seen.add(pid)
            allowed = {"accepted": ("confirm", "keep"), "rebutted": ("withdraw", "keep")}.get(cur["status"])
            if allowed is None:
                raise FormatError(f"{pid}: {NAMES[x]}가 응답할 차례인 지적입니다")
            if act not in allowed:
                raise FormatError(f"{pid}: 이 지적에는 {' 또는 '.join(allowed)}만 쓸 수 있습니다")
            text = "" if act == "confirm" else need_str(p, "grounds", pid)
            cur["history"].append({"round": rnd, "who": y, "action": act, "text": text})
            if act == "confirm":
                cur["status"] = "closed"
                cur["closed_how"] = "modified" if cur.get("applied") == "modified" else "applied"
            elif act == "withdraw":
                cur["status"], cur["closed_how"] = "closed", "withdrawn"
            else:
                if cur["status"] == "rebutted":
                    cur["clash"] += 1
                cur["status"] = "open"
        if added > cap:
            raise FormatError(f"새 지적은 최대 {cap}개입니다 ({added}개)")
        missing = [pid for pid in awaiting if pid not in seen]
        if missing:
            raise FormatError(f"응답하지 않은 지적: {', '.join(missing)}")
        left = unresolved(new)
        if data["approve"] and left:
            raise FormatError(f"남은 지적({', '.join(left)})이 있는데 approve가 true입니다")
        if not data["approve"] and not left:
            raise FormatError("남은 지적이 없는데 approve가 false입니다")
        return new

    st = call_step(st, d, y, f"r{rnd}_review", s, True, validate)
    log = f"\n## 라운드 {rnd} 검토 · {NAMES[y]}\n"
    for pid, p in st["points"].items():
        for h in p["history"]:
            if h["round"] == rnd and h["who"] == y:
                detail = (p["problem"] + " / " if h["action"] == "new" else "") + h["text"]
                log += f"- {pid} {h['action']}" + (f": {detail}" if detail else "") + "\n"
    append_log(d, log)

    left = unresolved(st)
    if not left:
        return finish(st, d, "합의")
    if rnd >= st["max_rounds"]:
        return finish(st, d, "합의 실패", "최대 라운드 도달")
    if all(st["points"][pid]["clash"] >= 2 for pid in left):
        return finish(st, d, "합의 실패", "남은 지적이 모두 교착")
    st["round"] += 1
    st["pending_step"] = "revise"
    return st


def step_revise(st, d):
    x, y = st["author"], OTHER[st["author"]]
    rnd = st["round"]
    opens = [pid for pid, p in st["points"].items() if p["status"] == "open"]

    s = (header(st, x) + f"\n[수정 · 라운드 {rnd}/{st['max_rounds']}]\n너는 작성자다. "
         f"검토자 {NAMES[y]}의 지적에 응답하고 초안을 고쳐라.\n"
         f"\n[현재 초안 v{st['draft_version']}]\n{st['draft']}\n"
         "\n[응답할 지적] 아래 지적마다 정확히 한 번씩 응답하라.\n")
    for pid in opens:
        p, h = st["points"][pid], last_by(st["points"][pid], y)
        s += point_text(pid, p, f"  {NAMES[y]}의 최신 의견: {h['text']}\n" if h["action"] == "keep" else "")
    s += ("- 수용(accept): 초안에 반영한다. 지적(또는 대체 문안)대로 반영했으면 applied=as_is, "
          "고쳐서 반영했으면 applied=modified와 이유(reason)\n"
          "- 반박(rebut): 반영하지 않고 근거(grounds)를 적는다\n"
          "본문에는 수정된 초안 전체를 써라. 지적과 관계없는 부분은 바꾸지 마라.\n" + JSON_TAIL + REVISE_JSON)

    def validate(body, data):
        if not body:
            raise FormatError("본문(수정된 초안)이 비어 있습니다")
        new = copy.deepcopy(st)
        rs = data.get("responses")
        if not isinstance(rs, list):
            raise FormatError("'responses' 목록이 필요합니다")
        seen = set()
        for i, r in enumerate(rs):
            if not isinstance(r, dict):
                raise FormatError(f"responses[{i}]가 객체가 아닙니다")
            pid = r.get("id")
            cur = new["points"].get(pid) if isinstance(pid, str) else None
            if cur is None or cur["status"] != "open":
                raise FormatError(f"{pid}: 응답할 차례인 지적이 아닙니다")
            if pid in seen:
                raise FormatError(f"{pid}: 두 번 응답했습니다")
            seen.add(pid)
            if r.get("reply") == "accept":
                applied = r.get("applied")
                if applied not in ("as_is", "modified"):
                    raise FormatError(f"{pid}: applied는 as_is 또는 modified여야 합니다")
                text = need_str(r, "reason", pid) if applied == "modified" else ""
                cur["status"], cur["applied"], cur["clash"] = "accepted", applied, 0
                cur["history"].append({"round": rnd, "who": x, "action": f"accept/{applied}", "text": text})
            elif r.get("reply") == "rebut":
                text = need_str(r, "grounds", pid)
                cur["status"] = "rebutted"
                cur["history"].append({"round": rnd, "who": x, "action": "rebut", "text": text})
            else:
                raise FormatError(f"{pid}: reply는 accept 또는 rebut여야 합니다")
        missing = [pid for pid in opens if pid not in seen]
        if missing:
            raise FormatError(f"응답하지 않은 지적: {', '.join(missing)}")
        new["draft"] = body
        new["draft_version"] += 1
        new["pending_step"] = "review"
        return new

    st = call_step(st, d, x, f"r{rnd}_revise", s, True, validate)
    log = f"\n## 라운드 {rnd} 수정 · {NAMES[x]} (초안 v{st['draft_version']})\n"
    for pid in opens:
        h = st["points"][pid]["history"][-1]
        log += f"- {pid} {h['action']}" + (f": {h['text']}" if h["text"] else "") + "\n"
    append_log(d, log + f"\n{st['draft']}")
    return st


def finish(st, d, result, reason=""):
    st["status"], st["pending_step"] = "done", None
    st["result"], st["fail_reason"] = result, reason
    (d / "final.md").write_text(st["draft"], encoding="utf-8")
    append_log(d, "\n" + report(st))
    return st


def report(st):
    x, y = st["author"], OTHER[st["author"]]
    s = f"## 결과: {st['result']}" + (f" ({st['fail_reason']})" if st["fail_reason"] else "") + "\n\n"
    s += f"- 작성자: {NAMES[x]} / 검토자: {NAMES[y]}\n- 최종 초안: final.md (v{st['draft_version']})\n"
    closed = [(pid, p) for pid, p in st["points"].items() if p["status"] == "closed"]
    if closed:
        s += "\n지적 처리:\n" + "".join(f"- {pid} {HOW_KO[p['closed_how']]}: {p['problem']}\n" for pid, p in closed)
    withdrawn = [(pid, p) for pid, p in closed if p["closed_how"] == "withdrawn"]
    s += f"\n철회된 지적: {len(withdrawn)}개\n"
    s += "".join(f"- {pid} 철회 근거: {last_by(p, y)['text']}\n" for pid, p in withdrawn)
    left = unresolved(st)
    if left:
        s += "\n남은 지적:\n"
        for pid in left:
            p = st["points"][pid]
            hx, hy = last_by(p, x), last_by(p, y)
            s += f"- {pid}: {p['problem']}\n"
            if hx:
                s += f"  {NAMES[x]} 마지막 응답 ({hx['action']}): {hx['text']}\n"
            s += f"  {NAMES[y]} 마지막 응답 ({hy['action']}): {hy['text']}\n"
    return s


def print_status(d, st):
    x, y = st["author"], OTHER[st["author"]]
    print(f"토의: {d.name}  (자동 합의 · 작성자 {NAMES[x]} / 검토자 {NAMES[y]})")
    if st["status"] == "done":
        print(f"상태: 종료 · 결과 {st['result']}")
    elif st["status"] == "halted":
        print(f"상태: 중단 · {STEP_KO[st['pending_step']]} 단계 · 사유: {st['halt_reason']}")
    else:
        who = {"r1": "두 AI", "draft": NAMES[x], "review": NAMES[y], "revise": NAMES[x]}[st["pending_step"]]
        print(f"상태: 진행 중 · 라운드 {st['round']}/{st['max_rounds']} · "
              f"다음 단계 {STEP_KO[st['pending_step']]} ({who})")
    wait = {"open": f"{NAMES[x]} 응답 대기", "accepted": f"{NAMES[y]} 확인 대기(수용됨)",
            "rebutted": f"{NAMES[y]} 응답 대기(반박됨)"}
    for pid, p in st["points"].items():
        state = f"종료({HOW_KO[p['closed_how']]})" if p["status"] == "closed" else wait[p["status"]]
        stall = " · 교착" if p["status"] == "open" and p["clash"] >= 2 else ""
        print(f"  {pid} {state}{stall}: {p['problem']}")
    if st.get("last_raw"):
        print("이번 단계 원문: " + ", ".join(st["last_raw"]))
    if st["status"] == "done":
        print("\n" + report(st))
        print(f"기록: {d / 'log.md'}")
    else:
        print(f"다음: python debate.py next {d.name}")


def run_pending(d, st):
    global WORKDIR
    WORKDIR = st["workdir"]
    step = st["pending_step"]
    steps, step_ko, show_fn = MODES[st["mode"]]
    st["status"], st["halt_reason"] = "running", None
    RAW_WRITTEN.clear()
    try:
        st = steps[step](copy.deepcopy(st), d)
    except Halt as e:
        st["status"], st["halt_reason"] = "halted", str(e)
        append_log(d, f"\n> 중단 ({step_ko[step]}): {e}\n")
    st["last_raw"] = list(RAW_WRITTEN)
    save(d, st)
    show_fn(d, st)


STEPS = {"r1": step_r1, "draft": step_draft, "review": step_review, "revise": step_revise}


def fake_consensus(st, tag, who, attempt):
    """--dry-run 용 가짜 응답. scenario로 합의·교착·최대 라운드·형식 오류·호출 실패를 만든다"""
    sc, rnd, pts = st["scenario"], st["round"], st["points"]
    if tag == "r1":
        crit = {"criteria": [f"{NAMES[who]} 기준", "비용"]}
        return f"({NAMES[who]}) 독립 답변\n\n```json\n{json.dumps(crit, ensure_ascii=False)}\n```"
    if tag == "draft":
        return f"## 판단 기준\n- 비용\n\n({NAMES[who]}) 통합 초안 v1"
    if tag.endswith("review"):
        if sc == "callfail":
            raise RuntimeError("가짜 호출 실패")
        if rnd == 1 and (sc == "format_halt" or (sc == "format" and attempt == 1)):
            return "검토 의견\n\n```json\n{\"points\": [\n```"
        out = []
        for pid, p in pts.items():
            if p["status"] == "accepted":
                out.append({"id": pid, "action": "keep" if sc == "maxround" else "confirm", "grounds": "가짜 근거"})
            elif p["status"] == "rebutted":
                out.append({"id": pid, "action": "keep" if sc == "stall" else "withdraw", "grounds": "가짜 근거"})
        if rnd == 1:
            n = 1 if sc in ("stall", "maxround") else 2
            out += [{"id": None, "action": "new", "problem": f"가짜 문제 {i + 1}", "grounds": "가짜 근거",
                     "criterion": "비용"} for i in range(n)]
        approve = all(o["action"] in ("confirm", "withdraw") for o in out)
        if sc == "badapprove" and rnd == 1 and attempt == 1:
            approve = True
        return f"검토 의견\n\n```json\n{json.dumps({'points': out, 'approve': approve}, ensure_ascii=False)}\n```"
    rs = []
    for i, pid in enumerate(pid for pid, p in pts.items() if p["status"] == "open"):
        if sc == "stall" or (sc != "maxround" and i % 2 == 1):
            rs.append({"id": pid, "reply": "rebut", "grounds": "가짜 반박"})
        elif sc == "maxround":
            rs.append({"id": pid, "reply": "accept", "applied": "modified", "reason": "가짜 사유"})
        else:
            rs.append({"id": pid, "reply": "accept", "applied": "as_is"})
    return (f"## 판단 기준\n- 비용\n\n({NAMES[who]}) 통합 초안 v{st['draft_version'] + 1}\n\n"
            f"```json\n{json.dumps({'responses': rs}, ensure_ascii=False)}\n```")


# wording·converge는 판정 모드 전용, badapprove는 자동 합의 모드 전용. format_halt는 판정 모드에서 누락 처리가 된다
SCENARIOS = ["agree", "stall", "maxround", "format", "format_halt", "badapprove", "callfail", "wording",
             "converge"]


def next_author():
    """토의마다 첫 작성자를 번갈아 정한다 (직전 자동 합의 토의의 반대쪽)"""
    last = None
    for f in sorted(DEBATES.glob("*/state.json")):
        try:
            s = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if s.get("mode") == "consensus":
            last = s.get("author")
    return OTHER[last] if last in OTHER else "claude"


# ── 사용자 판정 모드 (docs/judge-mode-flow.md) ────────────────────────
J_STEP_KO = {"r1": "R1 독립 답변", "r2": "R2 쟁점표 확인", "round": "쟁점 공방", "final_review": "최종안 검토"}
PHASE_KO = {"draft": "쟁점표 초안", "baseline": "쟁점표 확정", "debate": "쟁점 공방",
            "final": "최종안", "done": "종료"}
KIND_KO = {"issue": "쟁점", "agree_candidate": "합의 후보", "one_sided": "한쪽 항목"}
ITEM_KO = {"open": "논의 중", "agreed": "합의", "user_decided": "사용자 판정", "stall_candidate": "교착 후보",
           "deferred": "보류", "unverified": "미확인", "excluded": "제외", "wording_conflict": "표현 충돌"}
ONE_SIDED = ("agree", "disagree", "insufficient", "irrelevant")
UNRESOLVED = ("open", "stall_candidate", "wording_conflict")
CHECKS = ("agreements", "user_decisions", "unresolved_listed", "no_new_conclusions")
PHASE_CMDS = {
    "draft": ["edit", "next", "req", "end"],
    "baseline": ["edit", "pick-wording", "next", "note", "req", "exclude", "final", "end"],
    "debate": ["next", "judge", "judge-all", "note", "req", "defer", "exclude", "proposal", "reopen", "edit",
               "final-draft", "final", "end"],
    "final": ["final-draft", "final", "final-fix", "judge", "reopen", "edit", "confirm", "end"],
    "done": [],
}
CMD_USAGE = {
    "edit": "edit {id} --file ops.json",
    "next": "next {id}",
    "judge": "judge {id} <항목> claude|codex  /  judge {id} <항목> --text \"...\"",
    "judge-all": "judge-all {id} claude|codex",
    "note": "note {id} <항목|all> \"...\"",
    "req": "req {id} \"...\"",
    "defer": "defer {id} <항목>",
    "exclude": "exclude {id} <항목> [\"사유\"]",
    "pick-wording": "pick-wording {id} <항목> claude|codex",
    "proposal": "proposal {id} <N번호> accept|reject",
    "reopen": "reopen {id} <항목>",
    "final-draft": "final-draft {id}",
    "final": "final {id} --file draft.md",
    "final-fix": "final-fix {id} --file draft.md",
    "confirm": "confirm {id}",
    "end": "end {id}",
}

R2_JSON = """```json
{"items": [
  {"id": "I1", "wording": "ok", "position": "...", "grounds": "...",
   "rebuttal": "(선택) 상대 독립 답변의 어떤 주장과 어떻게 다른지"},
  {"id": "I2", "wording": {"revise": "수정한 질문", "reason": "..."}, "position": "(선택) 수정안 기준 입장"},
  {"id": "A1", "confirm": true, "note": "(선택) 동의하며 붙이는 전제·한정"},
  {"id": "A2", "confirm": false, "reason": "..."},
  {"id": "S1", "response": "agree | disagree | insufficient | irrelevant", "reason": "...",
   "note": "(agree일 때 선택) 동의하며 붙이는 전제·한정"}
], "missing_issues": [{"question": "...", "reason": "..."}]}
```
"""

FINAL_JSON = """```json
{"checks": {"agreements": "ok | problem", "user_decisions": "ok | problem",
            "unresolved_listed": "ok | problem", "no_new_conclusions": "ok | problem"},
 "points": [{"type": "wording | assembly | substance", "item": "I3", "problem": "...", "suggestion": "..."}]}
```
"""
POINT_KO = {"wording": "표현", "assembly": "조립", "substance": "실질"}
STANCE_KO = {"hold": "유지", "change": "변경", "withdraw": "철회"}


def round_example(st, who, rnd, ids):
    """R3 이후 JSON 예시. 쟁점마다 실제로 써야 하는 필드만 넣는다"""
    o, rows = OTHER[who], []
    for iid in ids:
        it, r = st["items"][iid], {"id": iid}
        if it["wording_changed_round"] == rnd - 1:
            r["prior_rebuttal_valid"] = True
        if it["last_rebuttal"].get(o):
            r.update(responds_to="상대 지적의 요지", reply="accept | counter", grounds="...")
        if who in it["positions"]:
            r.update(stance="hold | change | withdraw", position="(change일 때 필수, hold일 때 선택) 입장 문장 전체")
        else:
            r.update(stance="change", position="너의 입장")
        if o in it["positions"]:
            r["rebuttal"] = "(선택) 상대 현재 입장에 남은 차이나 문제. 없으면 빈 문자열"
        r["stall"] = None
        rows.append(r)
    items = ",\n  ".join(json.dumps(r, ensure_ascii=False) for r in rows)
    return ("```json\n{\"items\": [\n  " + items + "\n], \"new_issues\": "
            "[{\"question\": \"...\", \"grounds\": \"...\", \"impact\": \"결론에 미치는 영향\"}]}\n```\n")


def opt_str(obj, key):
    v = obj.get(key)
    return v.strip() if isinstance(v, str) else ""


def new_item(kind, text, origin, owner=None):
    it = {"kind": kind, "origin": origin, "text": text, "status": "open",
          "wording_changed_round": None, "wording_proposals": {},
          "positions": {}, "last_rebuttal": {},
          "keep_streak": {w: 0 for w in NAMES}, "missing": {w: 0 for w in NAMES},
          "stall_reason": None, "user_note": None, "resolution": None, "reason": None,
          "notes": {}, "converge": None}
    if owner:
        it["owner"] = owner
    return it


def add_item(st, prefix, item):
    iid = f"{prefix}{st['next_id'][prefix]}"
    st["next_id"][prefix] += 1
    st["items"][iid] = item
    return iid


def origin_of(bys):
    """제안한 쪽들을 하나로. 양쪽이 섞이면 both"""
    s = set(bys)
    return s.pop() if len(s) == 1 else "both"


def who_ko(w):
    return NAMES.get(w, "양측")


def open_issues(st):
    return [iid for iid, it in st["items"].items() if it["status"] == "open"]


def stall(it, reason):
    it["status"], it["stall_reason"] = "stall_candidate", reason


def defer_unresolved(st, reason):
    moved = [iid for iid, it in st["items"].items() if it["status"] in UNRESOLVED]
    for iid in moved:
        st["items"][iid]["status"], st["items"][iid]["reason"] = "deferred", reason
    return moved


def parse_items(data, expected, parse_one, strict):
    """항목별 응답 검사 → (통과한 응답, 누락 ID).
    strict면 오류가 하나라도 있으면 FormatError. 아니면 통과한 항목만 남기고 나머지는 누락으로 본다"""
    got, errors = {}, []
    rows = data.get("items") if data is not None else []
    if not isinstance(rows, list):
        errors.append("'items' 목록이 필요합니다")
        rows = []
    for i, r in enumerate(rows):
        iid = r.get("id") if isinstance(r, dict) else None
        if iid not in expected:
            errors.append(f"items[{i}]: 응답할 항목이 아닙니다 ({iid})")
        elif iid in got:
            errors.append(f"{iid}: 두 번 응답했습니다")
        else:
            try:
                got[iid] = parse_one(iid, r)
            except FormatError as e:
                errors.append(str(e))
    missing = [iid for iid in expected if iid not in got]
    if strict:
        if missing:
            errors.append(f"응답하지 않았거나 형식이 틀린 항목: {', '.join(missing)}")
        if errors:
            raise FormatError("; ".join(dict.fromkeys(errors)))
    return got, missing


def parse_list(data, key, fields, cap, strict):
    """missing_issues·new_issues 검사. 필드가 없으면 빈 목록으로 본다"""
    rows = (data or {}).get(key) or []
    if not isinstance(rows, list):
        if strict:
            raise FormatError(f"'{key}'는 목록이어야 합니다")
        return []
    out = []
    for i, r in enumerate(rows):
        try:
            if not isinstance(r, dict):
                raise FormatError(f"{key}[{i}]가 객체가 아닙니다")
            out.append({f: need_str(r, f, f"{key}[{i}]") for f in fields})
        except FormatError:
            if strict:
                raise
    if cap is not None and len(out) > cap:
        if strict:
            raise FormatError(f"{key}는 최대 {cap}개입니다 ({len(out)}개)")
        out = out[:cap]
    return out


def j_both(st, d, tag, prompts, make):
    """두 AI를 동시에 부른다. make(who, strict)가 검사 함수를 만든다.
    형식 오류 재시도까지 실패하면 멈추지 않고 strict=False 검사로 누락 처리한다"""
    with ThreadPoolExecutor(max_workers=2) as ex:   # 둘 다 성공해야 상태를 바꾼다
        futs = {w: ex.submit(call_step, st, d, w, tag, prompts[w], True, make(w, True), make(w, False))
                for w in NAMES}
        return {w: f.result() for w, f in futs.items()}


def pos_text(it, w):
    p = it["positions"].get(w)
    if not p:
        return "(아직 없음)"
    return p["text"] + (f"\n  근거: {p['grounds']}" if p.get("grounds") else "")


def how_text(r):
    """resolution이 어떻게 정해졌는지"""
    return {"agreement": "양측 확인", "withdraw": f"{who_ko(r.get('who'))} 철회",
            "moderator": "진행자 판단 합의",
            "user": "사용자 판정" + (f", {NAMES[r['who']]} 쪽" if r.get("who") else "")}[r["by"]]


def notes_lines(it, indent):
    """합의하며 붙인 단서 (예전 상태 파일에는 notes가 없다)"""
    return [f"{indent}단서({NAMES[w]}): {n}" for w, n in it.get("notes", {}).items()]


def concluded_text(st):
    lines = []
    for iid, it in st["items"].items():
        s = it["status"]
        if s in ("agreed", "user_decided"):
            lines.append(f"- {iid} ({ITEM_KO[s]}): {it['text']}\n  결론: {it['resolution']['text']}")
        elif s in ("unverified", "deferred"):
            lines.append(f"- {iid} ({ITEM_KO[s]}): {it['text']}")
        else:
            continue
        lines += notes_lines(it, "  ")
    return "\n".join(lines) or "(없음)"


def table_text(st):
    out = []
    for iid, it in st["items"].items():
        s = it["status"]
        kind = KIND_KO[it["kind"]] + (f"({NAMES[it['owner']]})" if it["kind"] == "one_sided" else "")
        out.append(f"- {iid} [{kind} · {ITEM_KO[s]}] {it['text']}")
        r = it["resolution"]
        if r:
            out.append(f"    결론 ({how_text(r)}, R{r['round']}): {r['text']}")
            if r.get("reason"):
                out.append(f"    진행자 판단 근거: {r['reason']}")
        out += notes_lines(it, "    ")
        if it["reason"]:
            out.append(f"    사유: {it['reason']}")
        if s == "stall_candidate":
            out.append(f"    교착 사유: {it['stall_reason']}")
        if s in UNRESOLVED or s == "deferred":
            for w in NAMES:
                if w in it["positions"]:
                    text = pos_text(it, w).replace("\n", "\n      ")
                    out.append(f"    {NAMES[w]} 입장 (R{it['positions'][w]['round']}): {text}")
            for w in NAMES:
                if it["last_rebuttal"].get(w):
                    out.append(f"    {NAMES[w]}의 남은 차이 지적: {it['last_rebuttal'][w]}")
            if it.get("converge"):
                out.append(f"    수렴 신호 (R{it['converge']['round']}): {', '.join(it['converge']['signals'])}"
                           " → 진행자 판단 필요 (edit op converge)")
            for w, p in it["wording_proposals"].items():
                out.append(f"    {NAMES[w]} 표현 수정안: {p['revise']} (이유: {p['reason']})")
            if it["user_note"]:
                out.append(f"    다음 라운드 사용자 의견: {it['user_note']}")
            counts = [f"{NAMES[w]} 유지 {it['keep_streak'][w]}연속·누락 {it['missing'][w]}" for w in NAMES]
            if any(it["keep_streak"].values()) or any(it["missing"].values()):
                out.append("    " + " / ".join(counts))
    return "\n".join(out) or "(항목 없음)"


# ── 판정 모드: AI 단계 ───────────────────────────────────────────────
def jstep_r1(st, d):
    prompt = {w: header(st, w) + "\n[1단계: 독립 답변]\n상대 답을 보지 않은 상태에서 너의 답을 근거와 함께 제시하라.\n"
              for w in NAMES}
    with ThreadPoolExecutor(max_workers=2) as ex:   # 둘 다 성공해야 상태를 바꾼다
        futs = {w: ex.submit(call_step, st, d, w, "r1", prompt[w], False, lambda body, _: body) for w in NAMES}
        st["r1"] = {w: f.result() for w, f in futs.items()}
    for w in NAMES:
        append_log(d, f"\n## R1 · {NAMES[w]}\n\n{st['r1'][w]}")
    st["round"], st["pending_step"] = 1, "r2"
    return st


def r2_expected(st, who):
    return [iid for iid, it in st["items"].items() if not (it["kind"] == "one_sided" and it["owner"] == who)]


def parse_r2_item(st, iid, r):
    kind = st["items"][iid]["kind"]
    if kind == "issue":
        w = r.get("wording")
        if w == "ok":
            return {"wording": "ok", "position": need_str(r, "position", iid),
                    "grounds": need_str(r, "grounds", iid), "rebuttal": opt_str(r, "rebuttal")}
        if isinstance(w, dict):
            return {"wording": {"revise": need_str(w, "revise", iid), "reason": need_str(w, "reason", iid)},
                    "position": opt_str(r, "position"), "grounds": opt_str(r, "grounds"),
                    "rebuttal": opt_str(r, "rebuttal")}
        raise FormatError(f"{iid}: wording은 \"ok\" 또는 {{\"revise\", \"reason\"}} 객체여야 합니다")
    if kind == "agree_candidate":
        if r.get("confirm") is True:
            return {"confirm": True, "note": opt_str(r, "note")}
        if r.get("confirm") is False:
            return {"confirm": False, "reason": need_str(r, "reason", iid)}
        raise FormatError(f"{iid}: confirm은 true 또는 false여야 합니다")
    resp = r.get("response")
    if resp not in ONE_SIDED:
        raise FormatError(f"{iid}: response는 {' / '.join(ONE_SIDED)} 중 하나여야 합니다")
    return {"response": resp, "reason": opt_str(r, "reason") if resp == "agree" else need_str(r, "reason", iid),
            "note": opt_str(r, "note") if resp == "agree" else ""}


def jstep_r2(st, d):
    def prompt(who):
        o = OTHER[who]
        s = (header(st, who) + f"\n[2단계: 쟁점표 확인 · 라운드 2/{st['max_rounds']}]\n"
             "진행자가 두 독립 답변을 보고 쟁점표 초안을 만들었다. 진행자는 쟁점의 질문만 적었고 양측 입장은 적지 않았다.\n"
             f"\n[너의 독립 답변]\n{st['r1'][who]}\n\n[{NAMES[o]}의 독립 답변]\n{st['r1'][o]}\n\n[쟁점표 초안]\n")
        groups = [("쟁점", lambda it: it["kind"] == "issue"),
                  ("합의 후보 (양측이 모두 확인해야 합의가 된다)", lambda it: it["kind"] == "agree_candidate"),
                  (f"{NAMES[o]}만 다룬 항목 (네가 분류한다)",
                   lambda it: it["kind"] == "one_sided" and it["owner"] == o)]
        for title, f in groups:
            rows = [f"- {iid}: {it['text']}\n" for iid, it in st["items"].items() if f(it)]
            if rows:
                s += f"{title}\n" + "".join(rows)
        mine = [iid for iid, it in st["items"].items() if it["kind"] == "one_sided" and it["owner"] == who]
        if mine:
            s += f"(너만 다룬 항목 {', '.join(mine)}는 {NAMES[o]}가 분류하므로 응답하지 마라)\n"
        s += ("\n- 쟁점: 질문 표현부터 확인하라. 정확하면 wording을 \"ok\"로 두고 너의 입장(position), 근거(grounds), "
              f"{NAMES[o]} 독립 답변과 다른 점(rebuttal: 상대의 어떤 주장과 어떻게 다른지)을 적어라. "
              "다른 점이 없으면 rebuttal은 비워 둔다. "
              "표현이 부정확하면 wording에 수정한 질문(revise)과 이유(reason)를 적어라. 이때 입장은 선택이다.\n"
              "- 합의 후보: 실제로 같은 의견이면 confirm을 true로, 아니면 false와 이유(reason)를 적어라. "
              "동의하되 전제나 한정을 붙인다면 note에 적어라.\n"
              f"- {NAMES[o]}만 다룬 항목: agree(동의) / disagree(반대) / insufficient(근거 부족) / "
              "irrelevant(주제와 무관) 중 하나로 분류하라. agree가 아니면 reason이 필요하다. "
              "agree에 전제나 한정을 붙인다면 note에 적어라.\n"
              "- 쟁점표에 빠진 쟁점이 있으면 missing_issues에 질문과 이유를 적어라.\n"
              "응답하라고 한 항목 ID마다 정확히 한 번씩 응답하라. 본문에는 너의 논증을 자유롭게 써라.\n"
              + JSON_TAIL + R2_JSON)
        return s

    def make(who, strict):
        def check(body, data, err=None):
            got, miss = parse_items(data, r2_expected(st, who), lambda iid, r: parse_r2_item(st, iid, r), strict)
            mi = parse_list(data, "missing_issues", ("question", "reason"), None, strict)
            return {"body": body, "items": got, "missing": miss, "missing_issues": mi, "error": err}
        return check

    res = j_both(st, d, "r2", {w: prompt(w) for w in NAMES}, make)
    log = ""
    for w in NAMES:
        log += f"\n## R2 · {NAMES[w]}\n\n{res[w]['body']}\n"
        if res[w]["error"]:
            log += f"\n> 형식 오류 (재시도 후): {res[w]['error']} → 누락: {', '.join(res[w]['missing']) or '없음'}\n"
    log += "\n### R2 처리\n"
    for iid, it in st["items"].items():
        r = {w: res[w]["items"].get(iid) for w in NAMES}
        if it["kind"] == "issue":
            for w in NAMES:
                x = r[w]
                if x is None:
                    it["missing"][w] += 1
                    continue
                if x["position"]:
                    it["positions"][w] = {"text": x["position"], "grounds": x["grounds"], "stance": None, "round": 2}
                if x["rebuttal"]:
                    it["last_rebuttal"][w] = x["rebuttal"]
                if x["wording"] != "ok":
                    it["wording_proposals"][w] = x["wording"]
            props = it["wording_proposals"]
            if len(props) == 2 and props["claude"]["revise"] != props["codex"]["revise"]:
                it["status"] = "wording_conflict"
                log += f"- {iid}: 양측이 서로 다른 표현 수정안 → 표현 충돌\n"
            elif props:
                log += f"- {iid}: 표현 수정안 ({', '.join(NAMES[w] for w in props)}) → 진행자 반영 대기\n"
        elif it["kind"] == "agree_candidate":
            objs = [w for w in NAMES if not (r[w] and r[w]["confirm"])]
            if not objs:
                it["status"] = "agreed"
                it["resolution"] = {"by": "agreement", "text": it["text"], "round": 2}
                it["notes"] = {w: r[w]["note"] for w in NAMES if r[w]["note"]}
                log += f"- {iid}: 양측 확인 → 합의" + (" (단서 있음)" if it["notes"] else "") + "\n"
                continue
            it["kind"] = "issue"
            for w in objs:
                if r[w]:
                    it["last_rebuttal"][w] = r[w]["reason"]
                else:
                    it["missing"][w] += 1
            it["reason"] = " / ".join(f"{NAMES[w]} " + (f"이의: {r[w]['reason']}" if r[w] else "응답 누락")
                                      for w in objs)
            log += f"- {iid}: 합의 후보 → 쟁점 ({it['reason']})\n"
        else:
            w = OTHER[it["owner"]]
            x = r[w]
            if x is None or x["response"] == "disagree":
                it["kind"] = "issue"
                if x is None:
                    it["missing"][w] += 1
                    it["reason"] = f"{NAMES[w]} 응답 누락"
                else:
                    it["last_rebuttal"][w], it["reason"] = x["reason"], f"{NAMES[w]} 반대: {x['reason']}"
                log += f"- {iid}: 한쪽 항목 → 쟁점 ({it['reason']})\n"
                continue
            it["reason"] = x["reason"] or None
            if x["response"] == "agree":
                it["status"] = "agreed"
                it["resolution"] = {"by": "agreement", "text": it["text"], "round": 2}
                if x["note"]:
                    it["notes"] = {w: x["note"]}
            else:
                it["status"] = "unverified" if x["response"] == "insufficient" else "excluded"
            log += f"- {iid}: {NAMES[w]} {x['response']} → {ITEM_KO[it['status']]}" + \
                   (f" (사유: {x['reason']})" if x["reason"] else "") + "\n"
    for w in NAMES:
        for m in res[w]["missing_issues"]:
            mid = f"M{st['next_id']['M']}"
            st["next_id"]["M"] += 1
            st["missing_issues"].append({"id": mid, "by": w, **m, "handled": None})
            log += f"- {mid} 빠진 쟁점 제안 ({NAMES[w]}): {m['question']} / 이유: {m['reason']}\n"
    append_log(d, log)
    st["last_summary"] = log.split("### R2 처리\n", 1)[1].splitlines()
    st["round"], st["phase"], st["pending_step"] = 2, "baseline", "round"
    return st


def parse_round_item(st, who, rnd):
    o = OTHER[who]

    def one(iid, r):
        it, out = st["items"][iid], {}
        if it["wording_changed_round"] == rnd - 1:
            if not isinstance(r.get("prior_rebuttal_valid"), bool):
                raise FormatError(f"{iid}: 표현이 바뀐 쟁점이라 prior_rebuttal_valid(true/false)가 필요합니다")
            out["prior_rebuttal_valid"] = r["prior_rebuttal_valid"]
        out["reply"] = None
        if it["last_rebuttal"].get(o):
            if r.get("reply") not in ("accept", "counter"):
                raise FormatError(f"{iid}: reply는 accept 또는 counter여야 합니다")
            out.update(responds_to=need_str(r, "responds_to", iid), reply=r["reply"],
                       grounds=need_str(r, "grounds", iid))
        stance = r.get("stance")
        if stance not in STANCE_KO:
            raise FormatError(f"{iid}: stance는 {' / '.join(STANCE_KO)} 중 하나여야 합니다")
        if stance == "hold" and who not in it["positions"]:
            raise FormatError(f"{iid}: 아직 입장이 없어 hold를 쓸 수 없습니다. change로 입장을 적어라")
        if stance == "withdraw" and o not in it["positions"]:
            raise FormatError(f"{iid}: {NAMES[o]}의 입장이 아직 없어 withdraw를 쓸 수 없습니다")
        out["stance"] = stance
        # hold는 주장 내용 유지: 표현을 다듬은 문장이 있으면 받아서 입장 문장을 바꾼다
        out["position"] = need_str(r, "position", iid) if stance == "change" else \
            opt_str(r, "position") if stance == "hold" else ""
        out["note"] = opt_str(r, "note") if stance == "withdraw" else ""
        out["rebuttal"] = opt_str(r, "rebuttal")   # 남은 차이가 없으면 비울 수 있다
        out["stall"] = opt_str(r, "stall") or None
        return out
    return one


def jstep_round(st, d):
    rnd, ids = st["round"] + 1, open_issues(st)

    def prompt(who):
        o = OTHER[who]
        s = (header(st, who) + f"\n[쟁점 공방 · 라운드 {rnd}/{st['max_rounds']}]\n"
             f"아래 미해결 쟁점마다 {NAMES[o]}가 지적한 차이에 답하고, 두 입장의 차이를 좁혀 결론을 찾아라. "
             "이기려고 하지 말고, 맞는 지적은 받아들여라.\n"
             f"\n[합의점과 확정된 결론]\n{concluded_text(st)}\n\n[미해결 쟁점]\n")
        for iid in ids:
            it = st["items"][iid]
            s += f"\n### {iid}: {it['text']}\n"
            if it["wording_changed_round"] == rnd - 1:
                s += "(지난 라운드에 질문 표현이 바뀌었다. 기존 지적이 아직 유효한지 prior_rebuttal_valid로 밝혀라)\n"
            s += (f"- 너의 현재 입장: {pos_text(it, who)}\n- {NAMES[o]}의 현재 입장: {pos_text(it, o)}\n"
                  f"- {NAMES[o]}가 지적한 남은 차이: {it['last_rebuttal'].get(o) or '(없음)'}\n")
            if it["user_note"]:
                s += f"- 사용자 의견 (반드시 반영): {it['user_note']}\n"
        if st["note_all"]:
            s += f"\n[사용자 의견 — 모든 쟁점에 반영]\n{st['note_all']}\n"
        s += (f"\n- {NAMES[o]}가 지적한 차이가 있으면 responds_to(어떤 지적에 답하는지 요지), "
              "reply(accept: 그 지적을 받아들임 / counter: 받아들이지 않음), grounds(근거)를 적어라.\n"
              "- stance: hold(주장 내용 유지. 표현만 다듬었으면 다듬은 문장 전체를 position에 적는다) / "
              "change(주장 내용을 바꿈. position에 새 입장 전체) / withdraw(철회: 상대 현재 입장을 받아들임. "
              "받아들이며 붙이는 전제·한정이 있으면 note에 적는다). 입장이 아직 없으면 change로 입장을 적어라.\n"
              "- rebuttal: 상대 현재 입장에 아직 남은 차이나 문제. 차이가 없으면 빈 문자열로 둔다.\n"
              "- stall: 더 공방해도 결론이 나지 않는다고 보면 그 사유를 적어라. 아니면 null.\n"
              "- new_issues: 결론에 영향을 주는데 쟁점표에 없는 쟁점 (최대 2개). 질문(question), 근거(grounds), "
              "결론에 미치는 영향(impact)을 적어라. 바로 공방에 넣지 않고 사용자가 추가 여부를 정한다.\n"
              "위 쟁점 ID마다 정확히 한 번씩 응답하라. 본문에는 쟁점별 논증을 자유롭게 써라.\n"
              + JSON_TAIL + round_example(st, who, rnd, ids))
        return s

    def make(who, strict):
        def check(body, data, err=None):
            got, miss = parse_items(data, ids, parse_round_item(st, who, rnd), strict)
            new = parse_list(data, "new_issues", ("question", "grounds", "impact"), 2, strict)
            return {"body": body, "items": got, "missing": miss, "new": new, "error": err}
        return check

    res = j_both(st, d, f"r{rnd}", {w: prompt(w) for w in NAMES}, make)
    log = f"\n## 라운드 {rnd}\n"
    for w in NAMES:
        log += f"\n### {NAMES[w]}\n\n{res[w]['body']}\n"
        if res[w]["error"]:
            log += f"\n> 형식 오류 (재시도 후): {res[w]['error']} → 누락: {', '.join(res[w]['missing']) or '없음'}\n"
    log += f"\n### 라운드 {rnd} 처리\n"
    for iid in ids:
        it = st["items"][iid]
        r = {w: res[w]["items"].get(iid) for w in NAMES}
        had = all(w in it["positions"] for w in NAMES)   # 첫 입장을 쓴 것은 수정으로 보지 않는다
        for w in NAMES:
            x = r[w]
            if x is None:
                it["missing"][w] += 1
                continue
            if x["stance"] == "change":
                it["positions"][w] = {"text": x["position"], "stance": "change", "round": rnd}
                it["keep_streak"][w] = 0
            elif w in it["positions"]:
                it["positions"][w]["stance"] = x["stance"]
                if x["stance"] == "hold":
                    it["keep_streak"][w] += 1
                    if x["position"]:
                        it["positions"][w].update(text=x["position"], round=rnd)
            # 이번에 남은 차이를 적지 않았으면 지난 지적은 해소된 것으로 본다
            if x["rebuttal"]:
                it["last_rebuttal"][w] = x["rebuttal"]
            else:
                it["last_rebuttal"].pop(w, None)
        it["user_note"], it["converge"] = None, None
        wd = [w for w in NAMES if r[w] and r[w]["stance"] == "withdraw"]
        if len(wd) == 2:
            stall(it, "양측이 모두 철회 (서로 상대 안을 받아들임)")
        elif wd:
            winner = OTHER[wd[0]]
            it["status"] = "agreed"
            it["resolution"] = {"by": "withdraw", "who": wd[0], "text": it["positions"][winner]["text"], "round": rnd}
            if r[wd[0]]["note"]:
                it.setdefault("notes", {})[wd[0]] = r[wd[0]]["note"]
        else:
            reasons = ["양측 2라운드 연속 유지"] if all(it["keep_streak"][w] >= 2 for w in NAMES) else []
            reasons += [f"{NAMES[w]}: {r[w]['stall']}" for w in NAMES if r[w] and r[w]["stall"]]
            reasons += [f"{NAMES[w]} 응답 누락 반복" for w in NAMES if it["missing"][w] >= 2]
            if reasons:
                stall(it, "; ".join(reasons))
            # 수렴 신호: 스크립트는 닫지 않고, 진행자가 converge op로 판단한다
            signals = (["상호 수용"] if all(r[w] and r[w]["reply"] == "accept" for w in NAMES) else []) + \
                      (["양측 수정"] if had and all(r[w] and r[w]["stance"] == "change" for w in NAMES) else []) + \
                      (["남은 차이 없음"] if all(r[w] and not r[w]["rebuttal"] for w in NAMES) else [])
            if signals and it["status"] == "open":
                it["converge"] = {"round": rnd, "signals": signals}
        acts = " / ".join(f"{NAMES[w]} " + (STANCE_KO[r[w]["stance"]] + ("·지적 수용" if r[w]["reply"] == "accept" else "")
                                            if r[w] else "누락") for w in NAMES)
        log += f"- {iid}: {acts} → {ITEM_KO[it['status']]}" + \
               (f" ({it['stall_reason']})" if it["status"] == "stall_candidate" else "") + \
               (f" · 수렴 신호: {', '.join(it['converge']['signals'])}" if it.get("converge") else "") + "\n"
    for w in NAMES:
        for n in res[w]["new"]:
            nid = f"N{st['next_id']['N']}"
            st["next_id"]["N"] += 1
            st["proposals"].append({"id": nid, "by": w, "round": rnd, "text": n["question"],
                                    "grounds": n["grounds"], "impact": n["impact"], "status": "pending"})
            log += f"- {nid} 새 쟁점 제안 ({NAMES[w]}): {n['question']}\n"
    st["round"], st["note_all"] = rnd, None
    if rnd >= st["max_rounds"]:
        moved = defer_unresolved(st, "최대 라운드 도달")
        st["phase"], st["pending_step"] = "final", None
        log += f"\n> 최대 라운드 도달: {', '.join(moved) or '남은 항목 없음'} 보류 → 최종안 단계\n"
    else:
        st["phase"], st["pending_step"] = "debate", "round"
    append_log(d, log)
    st["last_summary"] = log.split(f"### 라운드 {rnd} 처리\n", 1)[1].strip().splitlines()
    return st


def jstep_final(st, d):
    v = st["final"]["version"]
    prompt = {w: header(st, w) + "\n[최종안 검토]\n진행자가 토의 결과로 최종안을 조립했다. "
              "진행자는 조립만 하고 새 결론을 더하지 않아야 한다.\n"
              f"\n[합의점과 확정된 결론]\n{concluded_text(st)}\n\n[전체 쟁점표]\n{table_text(st)}\n"
              f"\n[최종안 v{v}]\n{st['final']['draft']}\n\n"
              "다음 네 가지를 확인하라.\n"
              "- agreements: 합의된 항목이 그대로 반영됐는가\n"
              "- user_decisions: 사용자 판정이 그대로 반영됐는가\n"
              "- unresolved_listed: 보류·미확인 항목이 미해결·미확인으로 명시됐는가\n"
              "- no_new_conclusions: 토의에 없던 결론이 추가되지 않았는가\n"
              "문제마다 points에 적고 type을 아래 셋 중 하나로 분류하라. "
              "item에는 관련 항목 ID를 적는다. 문제가 없으면 points를 빈 목록으로 둔다.\n"
              "- wording(표현): 뜻은 토의 기록과 맞고 문장만 고치면 된다\n"
              "- assembly(조립): 최종안이 토의 기록과 다르게 옮기거나, 항목을 묶어 뜻을 바꾸거나, 결론을 더했다\n"
              "- substance(실질): 최종안은 기록대로지만 토의 결론 자체에 문제가 있어 쟁점을 다시 논의해야 한다\n"
              + JSON_TAIL + FINAL_JSON
              for w in NAMES}

    def make(who, strict):
        def check(body, data, err=None):
            try:
                c = (data or {}).get("checks")
                if not isinstance(c, dict) or any(c.get(k) not in ("ok", "problem") for k in CHECKS):
                    raise FormatError(f"'checks'에 {', '.join(CHECKS)}가 각각 ok 또는 problem으로 있어야 합니다")
                pts = data.get("points")
                if not isinstance(pts, list):
                    raise FormatError("'points' 목록이 필요합니다")
                out = []
                for i, p in enumerate(pts):
                    if not isinstance(p, dict) or p.get("type") not in POINT_KO:
                        raise FormatError(f"points[{i}]: type은 {' / '.join(POINT_KO)} 중 하나여야 합니다")
                    out.append({"type": p["type"], "item": opt_str(p, "item"),
                                "problem": need_str(p, "problem", f"points[{i}]"),
                                "suggestion": opt_str(p, "suggestion")})
            except FormatError as e:
                if strict:
                    raise
                return {"version": v, "body": body, "checks": None, "points": [], "error": err or str(e)}
            return {"version": v, "body": body, "checks": {k: c[k] for k in CHECKS}, "points": out, "error": err}
        return check

    res = j_both(st, d, f"final_v{v}", prompt, make)
    log = ""
    for w in NAMES:
        r = res[w]
        log += f"\n## 최종안 v{v} 검토 · {NAMES[w]}\n\n{r['body']}\n"
        if r["error"]:
            log += f"\n> 형식 오류 (재시도 후): {r['error']}\n"
        else:
            log += "\n" + ", ".join(f"{k}={r['checks'][k]}" for k in CHECKS) + "\n"
            log += "".join(f"- [{POINT_KO[p['type']]}] {p['item'] or '-'}: {p['problem']}"
                           + (f" → {p['suggestion']}" if p["suggestion"] else "") + "\n" for p in r["points"])
    append_log(d, log)
    st["final"]["reviews"], st["pending_step"] = res, None
    st["last_summary"] = []   # 검토 결과는 print_judge의 [최종안] 절에 나온다
    return st


J_STEPS = {"r1": jstep_r1, "r2": jstep_r2, "round": jstep_round, "final_review": jstep_final}


def judge_blockers(st):
    """next를 부를 수 없는 이유 목록 (절차 조건만 본다)"""
    step = st["pending_step"]
    if st["status"] == "halted" or step in ("r1", "final_review"):
        return []
    if step is None:
        return ["지금은 실행할 AI 단계가 없습니다"]
    if step == "r2":
        return [] if st["items"] else ["쟁점표 초안을 먼저 edit로 넘겨야 합니다"]
    out = []
    for iid, it in st["items"].items():
        if it["status"] == "wording_conflict":
            out.append(f"{iid} 표현 충돌: pick-wording으로 골라야 합니다")
        elif it["status"] == "open" and it["wording_proposals"]:
            out.append(f"{iid} 표현 수정안이 반영되지 않았습니다 (edit op revise)")
    out += [f"{m['id']} 빠진 쟁점 제안이 반영되지 않았습니다 (edit op add)"
            for m in st["missing_issues"] if not m["handled"]]
    out += [f"{iid} 수렴 신호({', '.join(it['converge']['signals'])})를 진행자가 판단해야 합니다 (edit op converge)"
            for iid, it in st["items"].items() if it.get("converge") and it["status"] == "open"]
    if not open_issues(st):
        out.append("논의 중인 쟁점이 없습니다 (판정·추가 공방(reopen)·최종안 중에서 고르세요)")
    return out


def print_judge(d, st):
    print(f"토의: {d.name}  (사용자 판정 · 라운드 {st['round']}/{st['max_rounds']} · {PHASE_KO[st['phase']]} 단계)")
    if st["status"] == "halted":
        print(f"상태: 중단 · {J_STEP_KO[st['pending_step']]} 단계 · 사유: {st['halt_reason']}")
        print(f"재개: python debate.py next {d.name}")
    elif st["status"] == "done":
        print(f"상태: 종료 · {st['result']}")
    elif st["pending_step"]:
        print(f"다음 AI 단계: {J_STEP_KO[st['pending_step']]}")
    if st["requirements"]:
        print("\n[요구사항]")
        for r in st["requirements"]:
            print(f"  {r['id']}: {r['text']}" + (f" (R{r['round']} 뒤 추가)" if r["round"] else ""))
    if st.get("last_summary"):
        print("\n[직전 AI 단계 처리]\n" + "\n".join(st["last_summary"]))
    print("\n[쟁점표]\n" + table_text(st))
    ms = [m for m in st["missing_issues"] if not m["handled"]]
    if ms:
        print("\n[반영 대기 중인 빠진 쟁점 제안]")
        for m in ms:
            print(f"  {m['id']} ({NAMES[m['by']]}): {m['question']}\n    이유: {m['reason']}")
    ps = [p for p in st["proposals"] if p["status"] == "pending"]
    if ps:
        print("\n[새 쟁점 제안 (사용자 승인 대기)]")
        for p in ps:
            print(f"  {p['id']} ({who_ko(p['by'])}, R{p['round']}): {p['text']}\n"
                  f"    근거: {p['grounds']}\n    결론에 미치는 영향: {p['impact']}")
    f = st["final"]
    if f["draft"]:
        print(f"\n[최종안 v{f['version']}]")
        for w, r in f["reviews"].items():
            if r["error"]:
                print(f"  {NAMES[w]} 검토 (v{r['version']}): 형식 오류로 결과를 읽지 못함 — {r['error']}")
                continue
            bad = [k for k in CHECKS if r["checks"][k] != "ok"]
            print(f"  {NAMES[w]} 검토 (v{r['version']}): " + (f"문제 {', '.join(bad)}" if bad else "확인 항목 모두 ok"))
            for p in r["points"]:
                print(f"    - [{POINT_KO[p['type']]}] {p['item'] or '-'}: {p['problem']}"
                      + (f"\n      제안: {p['suggestion']}" if p["suggestion"] else ""))
    if st.get("last_raw"):
        print("\n직전 AI 단계 원문: " + ", ".join(st["last_raw"]))
    print(f"전체 기록: {(d / 'log.md').as_posix()}")
    if st["status"] == "done":
        return
    cmds = PHASE_CMDS[st["phase"]]
    blockers = judge_blockers(st) if "next" in cmds else []
    if blockers:
        print("\nnext 전에 할 일:\n" + "".join(f"  - {b}\n" for b in blockers), end="")
    print("\n쓸 수 있는 명령:")
    for c in cmds:
        if c == "next" and blockers:
            continue
        print("  python debate.py " + CMD_USAGE[c].format(id=d.name))


def fake_judge(st, tag, who, attempt):
    """--dry-run 용 가짜 응답 (판정 모드). scenario로 철회·교착·최대 라운드·표현 충돌·형식 오류·호출 실패를 만든다"""
    sc, items = st["scenario"], st["items"]

    def block(obj):
        return f"({NAMES[who]}) {tag} 본문\n\n```json\n{json.dumps(obj, ensure_ascii=False)}\n```"

    if tag == "r1":
        return f"({NAMES[who]}) 독립 답변"
    if sc == "callfail":
        raise RuntimeError("가짜 호출 실패")
    if tag == "r3" and who == "codex" and (sc == "format_halt" or (sc == "format" and attempt == 1)):
        return "본문\n\n```json\n{\"items\": [\n```"
    if tag == "r2":
        rows, n_a, n_s = [], 0, 0
        for iid, it in items.items():
            if it["kind"] == "issue":
                if sc == "wording" and iid == "I1":
                    rows.append({"id": iid, "wording": {"revise": f"{NAMES[who]}가 고친 질문", "reason": "가짜 사유"}})
                else:
                    rows.append({"id": iid, "wording": "ok", "position": f"{NAMES[who]} 입장 ({iid})",
                                 "grounds": "가짜 근거", "rebuttal": "가짜 반박"})
            elif it["kind"] == "agree_candidate":
                n_a += 1
                rows.append({"id": iid, "confirm": True, "note": f"{NAMES[who]} 가짜 단서"} if n_a == 1
                            else {"id": iid, "confirm": True} if who == "claude"
                            else {"id": iid, "confirm": False, "reason": "가짜 이의"})
            elif it["owner"] != who:
                resp = ONE_SIDED[n_s % 4]
                rows.append({"id": iid, "response": resp, "reason": "가짜 사유"}
                            | ({"note": "가짜 동의 단서"} if resp == "agree" else {}))
                n_s += 1
        mi = [{"question": "가짜 빠진 쟁점", "reason": "가짜 사유"}] if who == "codex" else []
        return block({"items": rows, "missing_issues": mi})
    if tag.startswith("final"):
        # Claude는 늘 표현 지적, Codex는 v1에 조립 지적·이후엔 실질 지적
        first = next(iter(items))
        pt = ({"type": "wording", "item": first, "problem": "가짜 표현 문제", "suggestion": "가짜 제안"}
              if who == "claude" else
              {"type": "assembly" if st["final"]["version"] == 1 else "substance", "item": first,
               "problem": "가짜 조립·실질 문제"})
        return block({"checks": {c: "ok" for c in CHECKS}, "points": [pt]})
    rnd, o, rows = st["round"] + 1, OTHER[who], []
    for i, iid in enumerate(open_issues(st)):
        it, r = items[iid], {"id": iid}
        if it["wording_changed_round"] == rnd - 1:
            r["prior_rebuttal_valid"] = True
        if it["last_rebuttal"].get(o):
            r.update(responds_to="가짜 요지", reply="accept" if sc == "converge" else "counter", grounds="가짜 근거")
        if who not in it["positions"] or sc in ("maxround", "converge"):
            r["stance"] = "change"
            r["position"] = f"{NAMES[who]} 입장 R{rnd} ({iid})"
        elif sc == "agree" and who == "codex" and i == 0 and o in it["positions"]:
            r["stance"], r["note"] = "withdraw", "가짜 철회 단서"
        else:
            r["stance"] = "hold"
            if i == 0:
                r["position"] = f"{NAMES[who]} 다듬은 입장 R{rnd} ({iid})"
        if r["stance"] != "withdraw" and sc != "converge":   # converge: 남은 차이 없음
            r["rebuttal"] = f"{NAMES[who]} 반박 R{rnd}"
        rows.append(r)
    new = ([{"question": f"가짜 새 쟁점 R{rnd}", "grounds": "가짜 근거", "impact": "가짜 영향"}]
           if who == "claude" and rnd == 3 else [])
    return block({"items": rows, "new_issues": new})


# ── 판정 모드: 진행자·사용자 명령 ─────────────────────────────────────
def open_judge(a):
    d = debate_dir(a.id)
    st = load(d)
    if st.get("mode") != "judge":
        sys.exit("사용자 판정 모드 토의가 아닙니다")
    if a.cmd not in PHASE_CMDS[st["phase"]]:
        allowed = ", ".join(PHASE_CMDS[st["phase"]]) or "없음"
        sys.exit(f"지금 단계({PHASE_KO[st['phase']]})에서는 {a.cmd}를 쓸 수 없습니다. 쓸 수 있는 명령: {allowed}")
    return d, st


def get_item(st, iid, statuses=None):
    it = st["items"].get(iid)
    if it is None:
        sys.exit(f"없는 항목입니다: {iid}")
    if statuses and it["status"] not in statuses:
        sys.exit(f"{iid}는 {ITEM_KO[it['status']]} 상태라 이 명령을 쓸 수 없습니다 "
                 f"(가능: {', '.join(ITEM_KO[s] for s in statuses)})")
    return it


def commit(d, st, log):
    append_log(d, log)
    save(d, st)
    print_judge(d, st)


def reset_final(st):
    """최종안을 만든 뒤 결론이 바뀌면 그 최종안은 다시 등록해야 한다"""
    if st["final"]["draft"]:
        st["final"]["draft"], st["final"]["reviews"] = None, {}
        if st["phase"] == "final":
            st["pending_step"] = None
        print("결론이 바뀌어 등록된 최종안을 내렸습니다. 최종안을 다시 조립해 final로 넘기세요.\n")


def edit_table(st, data):
    if not isinstance(data, dict) or not any(k in data for k in ("issues", "agree_candidates", "one_sided")):
        raise FormatError("쟁점표 초안은 {\"issues\", \"agree_candidates\", \"one_sided\"} 객체여야 합니다")
    st["items"] = {}
    st["next_id"].update(I=1, A=1, S=1)
    for key, kind, prefix in (("issues", "issue", "I"), ("agree_candidates", "agree_candidate", "A"),
                              ("one_sided", "one_sided", "S")):
        rows = data.get(key, [])
        if not isinstance(rows, list):
            raise FormatError(f"'{key}'는 목록이어야 합니다")
        for i, r in enumerate(rows):
            if not isinstance(r, dict):
                raise FormatError(f"{key}[{i}]가 객체가 아닙니다")
            text, owner = need_str(r, "text", f"{key}[{i}]"), None
            if kind == "one_sided":
                owner = r.get("owner")
                if owner not in NAMES:
                    raise FormatError(f"{key}[{i}]: owner는 claude 또는 codex여야 합니다")
            add_item(st, prefix, new_item(kind, text, "moderator", owner))
    if not st["items"]:
        raise FormatError("쟁점표에 항목이 하나도 없습니다")


def edit_ops(st, ops):
    allowed = {"baseline": ("revise", "add"),
               "debate": ("merge_proposals", "flag_missing", "converge"),
               "final": ("converge",)}[st["phase"]]   # 마지막 라운드의 수렴 신호는 보류된 뒤에 판단한다
    for i, op in enumerate(ops):
        where = f"ops[{i}]"
        if not isinstance(op, dict) or op.get("op") not in allowed:
            raise FormatError(f"{where}: 지금 단계에서 쓸 수 있는 op는 {', '.join(allowed)}입니다")
        if op["op"] == "revise":
            it = st["items"].get(op.get("id"))
            if not it or it["status"] != "open" or not it["wording_proposals"]:
                raise FormatError(f"{where}: 표현 수정안이 있는 논의 중 쟁점에만 쓸 수 있습니다 ({op.get('id')})")
            if op.get("source") not in it["wording_proposals"]:
                raise FormatError(f"{where}: source에는 수정안을 낸 AI({', '.join(it['wording_proposals'])})를 적어라")
            it["text"], it["wording_changed_round"] = need_str(op, "text", where), st["round"]
            it["wording_proposals"] = {}
        elif op["op"] == "add":
            src = op.get("source")
            src = [src] if isinstance(src, str) else src
            ms = {m["id"]: m for m in st["missing_issues"]}
            if not isinstance(src, list) or not src or any(s not in ms or ms[s]["handled"] for s in src):
                raise FormatError(f"{where}: source에는 반영하지 않은 빠진 쟁점 제안 ID(M번호)를 적어라")
            text = need_str(op, "text", where)
            iid = add_item(st, "I", new_item("issue", text, origin_of(ms[s]["by"] for s in src)))
            for s in src:
                ms[s]["handled"] = iid
        elif op["op"] == "merge_proposals":
            props = {p["id"]: p for p in st["proposals"]}
            ids = op.get("ids")
            if (not isinstance(ids, list) or len(set(ids)) < 2
                    or any(x not in props or props[x]["status"] != "pending" for x in ids)):
                raise FormatError(f"{where}: ids에는 승인 대기 중인 새 쟁점 제안을 두 개 이상 적어라")
            sel = [props[x] for x in dict.fromkeys(ids)]
            nid = f"N{st['next_id']['N']}"
            st["next_id"]["N"] += 1
            st["proposals"].append({"id": nid, "by": origin_of(p["by"] for p in sel), "round": st["round"],
                                    "text": need_str(op, "text", where),
                                    "grounds": "\n".join(f"({p['id']}) {p['grounds']}" for p in sel),
                                    "impact": "\n".join(f"({p['id']}) {p['impact']}" for p in sel),
                                    "status": "pending", "merged_from": [p["id"] for p in sel]})
            for p in sel:
                p["status"] = f"merged:{nid}"
        elif op["op"] == "converge":
            # 수렴 신호가 있는 쟁점을 진행자가 판단한다. 결론 문안은 두 입장 문장 안에서만 쓴다
            it = st["items"].get(op.get("id"))
            if not it or it["status"] not in ("open", "deferred") or not it.get("converge"):
                raise FormatError(f"{where}: 수렴 신호가 있는 논의 중·보류 쟁점에만 쓸 수 있습니다 ({op.get('id')})")
            if op.get("decision") not in ("agree", "open"):
                raise FormatError(f"{where}: decision은 agree 또는 open이어야 합니다")
            reason = need_str(op, "reason", where)
            if op["decision"] == "agree":
                it["status"] = "agreed"
                it["resolution"] = {"by": "moderator", "text": need_str(op, "text", where),
                                    "reason": reason, "signals": it["converge"]["signals"], "round": st["round"]}
                it["reason"] = None
                reset_final(st)
            it["converge"] = None
        else:
            it = st["items"].get(op.get("id"))
            if not it or it["status"] != "open":
                raise FormatError(f"{where}: 논의 중인 쟁점에만 쓸 수 있습니다 ({op.get('id')})")
            who = op.get("who")
            if who not in NAMES:
                raise FormatError(f"{where}: who는 claude 또는 codex여야 합니다")
            reason = need_str(op, "reason", where)
            it["missing"][who] += 1
            if it["missing"][who] >= 2:
                stall(it, f"{NAMES[who]} 응답 누락 반복 (진행자 표시: {reason})")


def cmd_edit(a):
    d, st = open_judge(a)
    raw = Path(a.file).read_text(encoding="utf-8")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        sys.exit(f"JSON을 읽을 수 없습니다: {e}")
    new = copy.deepcopy(st)
    try:
        if st["phase"] == "draft":
            if st["pending_step"] != "r2":
                sys.exit("R1이 끝난 뒤에 쟁점표를 넘길 수 있습니다")
            edit_table(new, data)
        else:
            # op 목록, {"ops": [...]}, op 하나 모두 받는다
            ops = data.get("ops", [data]) if isinstance(data, dict) else data
            if not isinstance(ops, list) or not ops:
                raise FormatError("op 목록이 필요합니다")
            edit_ops(new, ops)
    except FormatError as e:
        sys.exit(f"형식 오류: {e}")
    commit(d, new, f"\n## 진행자 쟁점표 입력 ({PHASE_KO[st['phase']]})\n\n```json\n{raw.strip()}\n```\n")


def cmd_judge(a):
    d, st = open_judge(a)
    it = get_item(st, a.item, ("open", "stall_candidate", "deferred"))
    if bool(a.who) == bool(a.text):
        sys.exit("claude|codex 또는 --text 중 하나만 적으세요")
    if a.who:
        if a.who not in it["positions"]:
            sys.exit(f"{a.item}에 {NAMES[a.who]}의 입장이 없습니다")
        text = it["positions"][a.who]["text"]
    else:
        text = a.text
    it["status"] = "user_decided"
    it["resolution"] = {"by": "user", "who": a.who, "text": text, "round": st["round"]}
    reset_final(st)
    commit(d, st, f"\n## 사용자 판정 (R{st['round']} 뒤)\n\n- {a.item} → "
                  + (f"{NAMES[a.who]} 쪽" if a.who else f"사용자 결론: {a.text}") + "\n")


def cmd_judge_all(a):
    d, st = open_judge(a)
    ids = [iid for iid, it in st["items"].items() if it["status"] in ("open", "stall_candidate")]
    if not ids:
        sys.exit("판정할 미해결 쟁점이 없습니다")
    lack = [iid for iid in ids if a.who not in st["items"][iid]["positions"]]
    if lack:
        sys.exit(f"{NAMES[a.who]}의 입장이 없는 쟁점이 있습니다: {', '.join(lack)}")
    for iid in ids:
        it = st["items"][iid]
        it["status"] = "user_decided"
        it["resolution"] = {"by": "user", "who": a.who, "text": it["positions"][a.who]["text"], "round": st["round"]}
    commit(d, st, f"\n## 사용자 판정 (R{st['round']} 뒤)\n\n- 남은 쟁점 전부({', '.join(ids)}) → {NAMES[a.who]} 쪽\n")


def cmd_note(a):
    d, st = open_judge(a)
    if a.target == "all":
        st["note_all"] = f"{st['note_all']}\n{a.text}" if st["note_all"] else a.text
    else:
        it = get_item(st, a.target, ("open",))
        it["user_note"] = f"{it['user_note']}\n{a.text}" if it["user_note"] else a.text
    commit(d, st, f"\n## 사용자 의견 (R{st['round']} 뒤)\n\n- {a.target}: {a.text}\n")


def cmd_req(a):
    d, st = open_judge(a)
    qid = f"Q{st['next_id']['Q']}"
    st["next_id"]["Q"] += 1
    st["requirements"].append({"id": qid, "text": a.text, "round": st["round"]})
    commit(d, st, f"\n## 요구사항 추가 (R{st['round']} 뒤)\n\n- {qid}: {a.text}\n")


def cmd_defer(a):
    d, st = open_judge(a)
    it = get_item(st, a.item, ("open", "stall_candidate"))
    it["status"], it["reason"] = "deferred", "사용자 보류"
    commit(d, st, f"\n## 사용자 판정 (R{st['round']} 뒤)\n\n- {a.item} 보류\n")


def cmd_exclude(a):
    d, st = open_judge(a)
    it = get_item(st, a.item, ("open", "stall_candidate", "deferred", "wording_conflict"))
    it["status"], it["reason"] = "excluded", f"사용자 제외: {a.reason}" if a.reason else "사용자 제외"
    commit(d, st, f"\n## 사용자 판정 (R{st['round']} 뒤)\n\n- {a.item} 제외" + (f": {a.reason}" if a.reason else "") + "\n")


def cmd_pick_wording(a):
    d, st = open_judge(a)
    it = get_item(st, a.item, ("wording_conflict",))
    it["text"] = it["wording_proposals"][a.who]["revise"]
    it["status"], it["wording_proposals"], it["wording_changed_round"] = "open", {}, st["round"]
    commit(d, st, f"\n## 사용자 판정\n\n- {a.item} 표현: {NAMES[a.who]} 수정안 선택 → {it['text']}\n")


def cmd_proposal(a):
    d, st = open_judge(a)
    p = next((p for p in st["proposals"] if p["id"] == a.nid), None)
    if p is None or p["status"] != "pending":
        sys.exit(f"승인 대기 중인 제안이 아닙니다: {a.nid}")
    if a.decision == "accept":
        iid = add_item(st, "I", new_item("issue", p["text"], p["by"]))
        p["status"], p["item"] = "accepted", iid
        log = f"- {a.nid} 승인 → 쟁점 {iid}: {p['text']}\n"
    else:
        p["status"] = "rejected"
        log = f"- {a.nid} 거절: {p['text']}\n"
    commit(d, st, f"\n## 새 쟁점 제안 처리 (R{st['round']} 뒤)\n\n{log}")


def cmd_reopen(a):
    d, st = open_judge(a)
    if st["phase"] == "debate":
        it = get_item(st, a.item, ("stall_candidate", "deferred"))
    else:
        it = get_item(st, a.item, [s for s in ITEM_KO if s not in ("open", "wording_conflict")])
    it.update(kind="issue", status="open", stall_reason=None, resolution=None, reason=None,
              keep_streak={w: 0 for w in NAMES}, missing={w: 0 for w in NAMES})
    reset_final(st)
    st["phase"], st["pending_step"] = "debate", "round"
    if st["round"] >= st["max_rounds"]:
        print("최대 라운드를 넘겨 한 라운드 더 진행합니다. 그 라운드가 끝나면 남은 쟁점은 다시 보류됩니다.\n")
    commit(d, st, f"\n## 쟁점 재개 (R{st['round']} 뒤)\n\n- {a.item}\n")


def cmd_final(a):
    d, st = open_judge(a)
    text = Path(a.file).read_text(encoding="utf-8").strip()
    if not text:
        sys.exit("최종안 파일이 비어 있습니다")
    moved = defer_unresolved(st, "최종안 요청 시 미해결")
    v = st["final"]["version"] + 1
    st["final"] = {"version": v, "draft": text, "reviews": {}}
    st["phase"], st["pending_step"] = "final", "final_review"
    need = [iid for iid, it in st["items"].items()
            if it["status"] in ("agreed", "user_decided", "deferred", "unverified")
            and not re.search(rf"(?<![A-Za-z0-9]){iid}(?![0-9])", text)]
    if need:
        print(f"주의: 최종안에 출처 ID가 없는 항목이 있습니다: {', '.join(need)}\n")
    append_log(d, f"\n## 최종안 v{v} (진행자 조립)\n\n"
                  + (f"> 미해결 항목 보류 처리: {', '.join(moved)}\n\n" if moved else "") + text)
    save(d, st)
    run_pending(d, st)


def final_skeleton(st):
    """최종안 뼈대. 항목 상태별로 나누고 출처 ID를 붙인다. 진행자는 결론 절과 문장 연결만 채운다"""
    s = (f"# {st['topic']} — 최종안\n\n- 주제: {st['topic']}\n"
         + "".join(f"- 요구사항 {r['id']}: {r['text']}\n" for r in st["requirements"])
         + f"- 진행: 라운드 {st['round']}/{st['max_rounds']}까지\n\n## 결론\n\n"
         "<!-- 진행자: 아래 항목에서 ID를 붙여 옮긴다. 새 결론이나 항목을 묶는 분류 소제목을 쓰지 않는다 -->\n")
    groups = [("합의", ("agreed",)), ("사용자 판정", ("user_decided",)),
              ("미해결 (보류)", ("deferred",) + UNRESOLVED), ("미확인", ("unverified",)), ("제외", ("excluded",))]
    for title, statuses in groups:
        rows = [(iid, it) for iid, it in st["items"].items() if it["status"] in statuses]
        if not rows:
            continue
        s += f"\n## {title}\n\n"
        for iid, it in rows:
            r = it["resolution"]
            if r:
                s += f"- {r['text']} ({iid}, {how_text(r)})\n"
                if r["text"] != it["text"]:
                    s += f"  - 쟁점: {it['text']}\n"
            else:
                s += f"- {iid}. {it['text']}\n"
                if it["status"] in ("deferred",) + UNRESOLVED:
                    s += "".join(f"  - {NAMES[w]} (R{it['positions'][w]['round']}): {it['positions'][w]['text']}\n"
                                 for w in NAMES if w in it["positions"])
                if it["reason"]:
                    s += f"  - 사유: {it['reason']}\n"
            s += "".join(f"{x}\n" for x in notes_lines(it, "  - "))
    return s


def cmd_final_draft(a):
    d, st = open_judge(a)
    path = d / "final_draft.md"
    path.write_text(final_skeleton(st), encoding="utf-8")
    print(f"최종안 뼈대: {path.as_posix()}\n결론 절과 문장 연결을 채운 뒤 final로 등록하세요.")


def cmd_final_fix(a):
    d, st = open_judge(a)
    f = st["final"]
    if not f["draft"] or st["pending_step"]:
        sys.exit("검토가 끝난 최종안이 있어야 표현 지적을 반영할 수 있습니다")
    asm = [f"{NAMES[w]}: {p['item'] or '-'}" for w, r in f["reviews"].items()
           for p in r["points"] if p["type"] == "assembly"]
    if asm:
        sys.exit(f"조립 지적({', '.join(asm)})이 있어 final-fix를 쓸 수 없습니다. 고친 최종안을 final로 다시 등록해 재검토하세요")
    text = Path(a.file).read_text(encoding="utf-8").strip()
    if not text:
        sys.exit("최종안 파일이 비어 있습니다")
    f["version"] += 1
    f["draft"] = text
    commit(d, st, f"\n## 최종안 v{f['version']} (표현 지적 반영, 재검토 없음)\n\n{text}")


def cmd_confirm(a):
    d, st = open_judge(a)
    if not st["final"]["draft"] or st["pending_step"]:
        sys.exit("검토가 끝난 최종안이 있어야 확정할 수 있습니다")
    (d / "final.md").write_text(st["final"]["draft"], encoding="utf-8")
    st["status"], st["phase"], st["result"] = "done", "done", f"최종 확정 (v{st['final']['version']})"
    commit(d, st, f"\n## 결과: {st['result']}\n\n- 최종안: final.md\n- 종료: {datetime.now():%Y-%m-%d %H:%M}\n")


def cmd_end(a):
    d, st = open_judge(a)
    st["status"], st["phase"], st["pending_step"], st["result"] = "done", "done", None, "판정 없이 종료"
    commit(d, st, f"\n## 결과: 판정 없이 종료\n\n- 종료: {datetime.now():%Y-%m-%d %H:%M}\n")


MODES = {"consensus": (STEPS, STEP_KO, print_status), "judge": (J_STEPS, J_STEP_KO, print_judge)}


# ── 명령 ─────────────────────────────────────────────────────────────
def cmd_start(a):
    spec = json.loads(Path(a.spec).read_text(encoding="utf-8"))
    mode = spec.get("mode", "consensus")
    if mode not in MODES:
        sys.exit(f"mode는 {' 또는 '.join(MODES)}여야 합니다")
    topic = (spec.get("topic") or "").strip()
    if not topic:
        sys.exit("spec에 topic이 필요합니다")
    files = spec.get("context", [])
    context = "\n\n".join(f"--- {f} ---\n{Path(f).read_text(encoding='utf-8')}" for f in files)
    workdir = spec.get("workdir")
    if workdir:
        workdir = str(Path(workdir).resolve())
        if not Path(workdir).is_dir():
            sys.exit(f"폴더가 없습니다: {workdir}")

    author = next_author() if mode == "consensus" else None
    # 토의 이름은 짧게: spec의 name(없으면 주제 앞 10자)
    slug = re.sub(r"[^\w가-힣]+", "_", (spec.get("name") or topic).strip())[:10].strip("_")
    d = DEBATES / f"{datetime.now():%Y%m%d-%H%M}_{slug}"
    n = 2
    while d.exists():   # 같은 분에 시작한 토의와 이름이 겹치면 번호를 붙인다
        d = d.with_name(f"{d.name.rsplit('~', 1)[0]}~{n}")
        n += 1
    (d / "raw").mkdir(parents=True)
    if mode == "judge":
        reqs = spec.get("requirements", [])
        st = {"id": d.name, "mode": "judge", "topic": topic, "background": spec.get("background", ""),
              "requirements": [{"id": f"Q{i}", "text": t, "round": 0} for i, t in enumerate(reqs, 1)],
              "context_files": files, "context": context, "workdir": workdir,
              "max_rounds": max(3, int(spec.get("max_rounds", 5))),   # R1, R2 포함
              "dry_run": a.dry_run, "scenario": a.scenario,
              "status": "running", "pending_step": "r1", "halt_reason": None,
              "phase": "draft", "round": 0, "r1": {}, "items": {},
              "next_id": {"I": 1, "A": 1, "S": 1, "N": 1, "M": 1, "Q": len(reqs) + 1},
              "missing_issues": [], "proposals": [], "note_all": None,
              "final": {"version": 0, "draft": None, "reviews": {}}, "result": None}
        save(d, st)
        append_log(d, f"# {topic}\n\n- 모드: 사용자 판정\n- 시작: {datetime.now():%Y-%m-%d %H:%M}\n"
                      + (f"- 참조 파일: {', '.join(files)}\n" if files else "")
                      + (f"- 작업 폴더: {workdir}\n" if workdir else "")
                      + ("- dry-run: " + a.scenario + "\n" if a.dry_run else ""))
        run_pending(d, st)
        return
    st = {"id": d.name, "mode": "consensus", "topic": topic,
          "background": spec.get("background", ""), "requirements": spec.get("requirements", []),
          "context_files": files, "context": context, "workdir": workdir,
          "max_rounds": max(2, int(spec.get("max_rounds", 5))),
          "author": author, "dry_run": a.dry_run, "scenario": a.scenario,
          "status": "running", "pending_step": "r1", "halt_reason": None,
          "round": 0, "r1": {}, "criteria": {}, "draft": "", "draft_version": 0,
          "points": {}, "next_point": 1, "result": None, "fail_reason": ""}
    save(d, st)
    append_log(d, f"# {topic}\n\n- 모드: AI 자동 합의\n- 시작: {datetime.now():%Y-%m-%d %H:%M}\n"
                  f"- 작성자: {NAMES[author]} / 검토자: {NAMES[OTHER[author]]}\n"
                  + (f"- 참조 파일: {', '.join(files)}\n" if files else "")
                  + (f"- 작업 폴더: {workdir}\n" if workdir else "")
                  + ("- dry-run: " + a.scenario + "\n" if a.dry_run else ""))
    run_pending(d, st)


def cmd_next(a):
    d = debate_dir(a.id)
    st = load(d)
    show_fn = MODES[st["mode"]][2]
    if st["status"] == "done":
        print("이미 끝난 토의입니다.\n")
        show_fn(d, st)
        return
    if st["mode"] == "judge":
        blockers = judge_blockers(st)
        if blockers:
            sys.exit("next를 실행할 수 없습니다:\n" + "".join(f"  - {b}\n" for b in blockers))
    if a.scenario:
        if not st["dry_run"]:
            sys.exit("--scenario는 dry-run 토의에서만 쓸 수 있습니다")
        st["scenario"] = a.scenario
    run_pending(d, st)


def cmd_show(a):
    d = debate_dir(a.id)
    st = load(d)
    MODES[st["mode"]][2](d, st)


def main():
    # 파이프로 읽을 때 Windows 기본 인코딩(cp949) 대신 UTF-8로 출력한다
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description="Claude × Codex 토의")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("start", help="토의를 만들고 R1을 실행")
    p.add_argument("--spec", required=True, help="주제·배경·요구사항 등을 담은 JSON 파일")
    p.add_argument("--dry-run", action="store_true", help="CLI 호출 없이 가짜 응답으로 시험")
    p.add_argument("--scenario", choices=SCENARIOS, default="agree", help="dry-run 시나리오")
    p.set_defaults(fn=cmd_start)

    p = sub.add_parser("next", help="다음 단계 실행 (중단된 단계는 다시 실행)")
    p.add_argument("id")
    p.add_argument("--scenario", choices=SCENARIOS, help="dry-run 시나리오 변경")
    p.set_defaults(fn=cmd_next)

    p = sub.add_parser("show", help="현재 상태 출력")
    p.add_argument("id")
    p.set_defaults(fn=cmd_show)

    # 사용자 판정 모드 전용 명령 (docs/judge-mode-flow.md "하위 명령")
    who = ["claude", "codex"]
    p = sub.add_parser("edit", help="쟁점표 작성·수정 (진행자)")
    p.add_argument("id")
    p.add_argument("--file", required=True, help="쟁점표 초안 또는 op 목록 JSON")
    p.set_defaults(fn=cmd_edit)

    p = sub.add_parser("judge", help="쟁점 판정")
    p.add_argument("id")
    p.add_argument("item")
    p.add_argument("who", nargs="?", choices=who)
    p.add_argument("--text", help="사용자 결론")
    p.set_defaults(fn=cmd_judge)

    p = sub.add_parser("judge-all", help="미해결 쟁점 전체를 한쪽으로 판정")
    p.add_argument("id")
    p.add_argument("who", choices=who)
    p.set_defaults(fn=cmd_judge_all)

    p = sub.add_parser("note", help="다음 라운드에 붙일 사용자 의견")
    p.add_argument("id")
    p.add_argument("target", help="항목 ID 또는 all")
    p.add_argument("text")
    p.set_defaults(fn=cmd_note)

    p = sub.add_parser("req", help="요구사항 추가")
    p.add_argument("id")
    p.add_argument("text")
    p.set_defaults(fn=cmd_req)

    p = sub.add_parser("defer", help="쟁점 보류")
    p.add_argument("id")
    p.add_argument("item")
    p.set_defaults(fn=cmd_defer)

    p = sub.add_parser("exclude", help="쟁점 제외 (최종안에 넣지 않음)")
    p.add_argument("id")
    p.add_argument("item")
    p.add_argument("reason", nargs="?", help="사유 (로그에 남김)")
    p.set_defaults(fn=cmd_exclude)

    p = sub.add_parser("pick-wording", help="표현 충돌 해결")
    p.add_argument("id")
    p.add_argument("item")
    p.add_argument("who", choices=who)
    p.set_defaults(fn=cmd_pick_wording)

    p = sub.add_parser("proposal", help="새 쟁점 제안 승인·거절")
    p.add_argument("id")
    p.add_argument("nid")
    p.add_argument("decision", choices=["accept", "reject"])
    p.set_defaults(fn=cmd_proposal)

    p = sub.add_parser("reopen", help="교착·보류 쟁점 추가 공방, 또는 최종안 실질 지적 쟁점 재개")
    p.add_argument("id")
    p.add_argument("item")
    p.set_defaults(fn=cmd_reopen)

    p = sub.add_parser("final-draft", help="최종안 뼈대 만들기 (항목 상태별, 출처 ID 포함)")
    p.add_argument("id")
    p.set_defaults(fn=cmd_final_draft)

    for name, fn, h in (("final", cmd_final, "최종안 등록 후 두 AI 검토"),
                        ("final-fix", cmd_final_fix, "최종안 표현 지적 반영 (재검토 없음)")):
        p = sub.add_parser(name, help=h)
        p.add_argument("id")
        p.add_argument("--file", required=True, help="최종안 Markdown 파일")
        p.set_defaults(fn=fn)

    for name, fn, h in (("confirm", cmd_confirm, "최종 확정"), ("end", cmd_end, "판정 없이 종료")):
        p = sub.add_parser(name, help=h)
        p.add_argument("id")
        p.set_defaults(fn=fn)

    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
