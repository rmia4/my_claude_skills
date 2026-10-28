#!/usr/bin/env node
/* Claude(Claude Code) + Codex(Codex CLI) 토의 진행 스크립트 (Node.js 18 이상, 외부 패키지 없음)

설계 문서: docs/common.md, docs/auto-mode-flow.md, docs/manual-mode-flow.md

명령
  start --spec spec.json   토의를 만들고 첫 단계(R1)를 실행한다
  next <id>                다음 단계를 실행한다 (중단된 단계는 다시 실행)
  show <id>                현재 상태와 결과를 출력한다
  자동 모드 전용: run <id> (종료나 중단까지 단계를 이어서 실행, 중단이면 종료 코드 1)
  수동 모드 전용: edit, judge, judge-all, note, req, defer, exclude, pick-wording,
                        proposal, reopen, final-draft, final, final-fix, confirm, end (-h로 사용법 확인)
  <id>에는 토의 이름, last(가장 최근 토의), 이름 앞부분을 쓸 수 있다
  --mode manual|auto를 붙이면 토의의 mode와 다를 때 거부한다 (모드 스킬은 항상 붙인다)
  start에서는 spec의 mode와 비교한다

spec.json 예 (mode는 필수: "auto" 또는 "manual". via는 선택: 호출한 진입점, 예 "start")
  {"mode": "auto", "topic": "...", "background": "...",
   "requirements": ["..."], "context": ["배경.md"], "workdir": "C:/dev/myproject",
   "max_rounds": 5, "clean_final": true}   (clean_final은 자동 모드 전용, 기본 true)
  선택: "claude_model" (참가 Claude 모델, 기본은 CLAUDE_MODEL 상수)

사용 예
  node discussion.mjs start --spec spec.json
  node discussion.mjs next 20261026-103000_주제
  node discussion.mjs start --spec spec.json --dry-run --scenario stall   # CLI 없이 규칙 시험
*/
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── CLI 실행 설정 (설치된 버전에 맞게 조정) ────────────────────────────
const CLAUDE_CMD = ["claude", "-p", "--output-format", "json"];   // 프롬프트는 stdin으로 전달. json이라야 usage가 나온다
const CODEX_CMD = ["codex", "exec", "--skip-git-repo-check", "--sandbox", "read-only", "--json"];   // --json: stdout JSONL에 usage
// 참가 Claude의 하네스 문맥을 줄인다: 사용자 MCP·스킬·user/local 설정(훅·CLAUDE.md 등)을 싣지 않는다
const CLAUDE_LEAN = ["--strict-mcp-config", "--disable-slash-commands", "--setting-sources", "project"];
const CLAUDE_MODEL = "claude-opus-5-5";   // spec의 claude_model이 없을 때. user 설정을 안 읽으므로 모델을 직접 정한다
const TIMEOUT_SEC = 600;
let WORKDIR = null;   // --workdir 지정 시 두 AI가 이 폴더의 파일을 읽기 전용으로 참조
let RUN_DIR = null;   // 두 CLI의 작업 폴더: WORKDIR, 없으면 단계마다 만드는 빈 임시 폴더
let MODEL = CLAUDE_MODEL;
const RETRIES = 2;
const BACKOFF_SEC = [10, 30];   // 재시도마다 앞서 기다리는 초 (RETRIES만큼, 모델 용량 부족 같은 일시 오류 대비). dry-run에서는 기다리지 않는다

const NAMES = { claude: "Claude", codex: "Codex" };
const OTHER = { claude: "codex", codex: "claude" };
const WHO = Object.keys(NAMES);


// ── 기본 도구 ────────────────────────────────────────────────────────
class FormatError extends Error {}
class Halt extends Error {}
class Exit extends Error {   // 메시지를 stderr에 쓰고 종료 코드를 남기고 끝낸다
  constructor(message, code = 1) { super(message); this.code = code; }
}
const die = (msg) => { throw new Exit(msg); };

const isStr = (v) => typeof v === "string";
const isDict = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
// AI·진행자가 준 키로 객체를 볼 때 프로토타입 속성(constructor 등)을 잡지 않도록 자기 속성만 본다
const has = (o, k) => typeof k === "string" && Object.hasOwn(o, k);
const own = (o, k) => (has(o, k) ? o[k] : undefined);
const isEmpty = (o) => Object.keys(o).length === 0;

// 기록 파일은 LF로 쓴다. 읽을 때는 CRLF로 저장된 파일도 받는다
const readText = (p) => fs.readFileSync(p, "utf8").replace(/\r\n?/g, "\n");
const writeText = (p, s) => fs.writeFileSync(p, s, "utf8");
const posix = (p) => p.split(path.sep).join("/");
const print = (s = "") => process.stdout.write(s + "\n");

const pad = (n) => String(n).padStart(2, "0");
const stamp = (t = new Date()) =>
  `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}`;
const clock = (t = new Date()) =>
  `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;


// ── AI 호출 ──────────────────────────────────────────────────────────
function which(name) {
  const exts = process.platform === "win32"
    ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter((e) => /^\.(com|exe|bat|cmd)$/i.test(e))
    : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch { /* 없으면 다음 후보 */ }
    }
  }
  return null;
}

function run(name, args, input, cwd) {
  return new Promise((resolve, reject) => {
    const exe = which(name) || name;
    const opts = { cwd: cwd || undefined, windowsHide: true };
    // Windows에서 npm으로 설치한 CLI는 .cmd라 cmd.exe를 거쳐야 실행된다. 인자는 따옴표로 감싼다
    const p = process.platform === "win32" && /\.(cmd|bat)$/i.test(exe)
      ? spawn(`"${exe}" ${args.map((x) => `"${x}"`).join(" ")}`, { ...opts, shell: true })
      : spawn(exe, args, opts);
    // spawn의 timeout 옵션은 실행 실패(ENOENT) 때 타이머가 남아 프로세스가 끝나지 않으므로 직접 건다
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill();
    }, TIMEOUT_SEC * 1000);
    const out = [], err = [];
    p.stdout.on("data", (b) => out.push(b));
    p.stderr.on("data", (b) => err.push(b));
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on("close", (code, signal) => {
      clearTimeout(timer);
      const text = (bs) => Buffer.concat(bs).toString("utf8").replace(/\r\n?/g, "\n");
      if (timedOut) reject(new Error(`시간 초과 (${TIMEOUT_SEC}초)`));
      else if (code === null) reject(new Error(`강제 종료 (${signal})`));
      else resolve({ code, stdout: text(out), stderr: text(err) });
    });
    p.stdin.on("error", () => {});   // 프로그램이 입력을 다 읽기 전에 끝나도 오류는 종료 코드로 알린다
    p.stdin.end(input, "utf8");
  });
}

function callError(r) {
  // 메시지는 짧게: ERROR로 시작하는 줄(중복 제거), 없으면 마지막 3줄. 전체 stderr는 raw에 남기도록 붙여 둔다
  const lines = r.stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  const errs = [...new Set(lines.filter((l) => l.startsWith("ERROR")))];
  const e = new Error((errs.length ? errs : lines.slice(-3)).join(" / ") || `exit ${r.code}`);
  e.stderr = r.stderr;
  return e;
}

// 호출 결과는 { text, usage }. usage는 두 CLI를 같은 뜻으로 맞춘 토큰 수다(input은 캐시 읽기·쓰기를 포함한 전체 입력)
async function callClaude(prompt) {
  const args = [...CLAUDE_CMD.slice(1), ...CLAUDE_LEAN, "--model", MODEL,
    ...(WORKDIR ? ["--tools", "Read,Glob,Grep", "--allowedTools", "Read,Glob,Grep"] : ["--tools", ""])];
  const r = await run(CLAUDE_CMD[0], args, prompt, RUN_DIR);
  let j = null;
  try {
    j = JSON.parse(r.stdout);
  } catch { /* JSON이 아니면 stdout 전체를 본문으로 쓴다 */ }
  if (r.code !== 0 || j?.is_error) {
    const e = callError(r);
    if (isStr(j?.result) && j.result.trim()) e.message = j.result.trim();
    throw e;
  }
  if (!isDict(j)) return { text: r.stdout.trim(), usage: null };
  const u = j.usage ?? {};
  const [read, write] = [u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0];
  return {
    text: isStr(j.result) ? j.result.trim() : "",
    usage: {
      model: Object.keys(j.modelUsage ?? {}).join(",") || null,
      input: (u.input_tokens ?? 0) + read + write, cache_read: read, cache_write: write,
      output: u.output_tokens ?? 0, cost_usd: j.total_cost_usd ?? null,
    },
  };
}

function codexUsage(stdout) {
  // JSONL 이벤트 중 turn.completed의 usage를 더한다. input_tokens는 캐시 읽기를 포함한다
  let sum = null;
  for (const line of stdout.split("\n")) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev?.type !== "turn.completed" || !isDict(ev.usage)) continue;
    const u = ev.usage;
    sum ??= { model: null, input: 0, cache_read: 0, cache_write: 0, output: 0, cost_usd: null };
    sum.input += u.input_tokens ?? 0;
    sum.cache_read += u.cached_input_tokens ?? 0;
    sum.cache_write += u.cache_write_input_tokens ?? 0;
    sum.output += u.output_tokens ?? 0;
  }
  return sum;
}

async function callCodex(prompt) {
  // 진행 로그와 섞이지 않도록 최종 답변만 파일로 받는다
  const out = path.join(os.tmpdir(), `discussion-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(out, "");
  try {
    const args = [...CODEX_CMD.slice(1), "--cd", RUN_DIR, "--output-last-message", out, "-"];
    const r = await run(CODEX_CMD[0], args, prompt, null);
    if (r.code !== 0) throw callError(r);
    return { text: readText(out).trim(), usage: codexUsage(r.stdout) };
  } finally {
    fs.rmSync(out, { force: true });
  }
}

async function ask(who, prompt, fake = null) {
  // fake: --dry-run 용 가짜 호출 함수(본문 문자열을 돌려준다). 실제 호출과 같은 재시도를 거친다
  const fn = fake || (who === "claude" ? callClaude : callCodex);
  let last = null;
  for (let i = 0; i <= RETRIES; i++) {
    if (i && !fake) await new Promise((ok) => setTimeout(ok, BACKOFF_SEC[i - 1] * 1000));
    try {
      const t0 = Date.now();
      const r = await fn(prompt);
      const out = isStr(r) ? { text: r, usage: null } : r;
      if (!out.text.trim()) throw new Error("빈 응답");
      return { ...out, ms: Date.now() - t0 };
    } catch (e) {   // 시간 초과·실행 오류·빈 응답은 재시도
      last = e;
      process.stderr.write(`  ! ${NAMES[who]} 호출 실패, 재시도: ${e.message}\n`);
    }
  }
  const e = new Error(`${NAMES[who]} 호출이 계속 실패했습니다: ${last.message}`);
  e.stderr = last.stderr;
  throw e;
}

async function both(calls) {
  // 두 AI를 동시에 부르되, 둘 다 끝난 뒤에 결과를 본다 (둘 다 성공해야 상태를 바꾼다)
  const rs = await Promise.allSettled(calls);
  const bad = rs.find((r) => r.status === "rejected");
  if (bad) throw bad.reason;
  return Object.fromEntries(WHO.map((w, i) => [w, rs[i].value]));
}


// ── 공통: 상태·파싱·재시도 (docs/common.md) ──────────────────────────
const DISCUSSIONS = "discussions";   // 호출한 프로젝트 폴더에 쌓는다

const JSON_BLOCK_RE = /```json[ \t]*\n([\s\S]*?)```/g;
const JSON_TAIL = "\n응답 맨 끝에 아래 형식의 ```json 코드 블록을 하나 붙여라.\n";

function splitJson(text, needsJson) {
  // [본문, 데이터, 오류]. 마지막 ```json 블록만 읽고, 그 앞부분 전체를 본문으로 본다
  if (!needsJson) return [text.trim(), null, null];
  const blocks = [...text.matchAll(JSON_BLOCK_RE)];
  if (!blocks.length) return [text.trim(), null, "```json 블록이 없습니다"];
  const m = blocks.at(-1);
  const body = text.slice(0, m.index).trim();
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch (e) {
    return [body, null, `JSON을 읽을 수 없습니다: ${e.message}`];
  }
  if (!isDict(data)) return [body, null, "JSON 최상위는 객체여야 합니다"];
  return [body, data, null];
}

function needStr(obj, key, where) {
  const v = obj[key];
  if (!isStr(v) || !v.trim()) throw new FormatError(`${where}: '${key}'가 비어 있습니다`);
  return v.trim();
}

const bullets = (items) => [...items].map((x) => `- ${x}\n`).join("");

function listDiscussions() {
  let names;
  try {
    names = fs.readdirSync(DISCUSSIONS);
  } catch {
    return [];
  }
  return names.sort().map((n) => path.join(DISCUSSIONS, n)).filter((p) => fs.existsSync(path.join(p, "state.json")));
}

function discussionDir(id) {
  // 경로, 토의 이름, last(가장 최근 토의), 이름 앞부분(하나만 맞을 때)을 받는다
  for (const d of [path.normalize(id), path.join(DISCUSSIONS, id)]) {
    if (fs.existsSync(path.join(d, "state.json"))) return d;
  }
  const found = listDiscussions();
  if (id === "last" && found.length) return found.at(-1);   // 이름이 시작 시각으로 시작하므로 이름순 마지막이 가장 최근이다
  const hits = found.filter((p) => path.basename(p).startsWith(id));
  if (hits.length === 1) return hits[0];
  if (hits.length) die(`여러 토의가 맞습니다: ${hits.map((p) => path.basename(p)).join(", ")}`);
  die(`토의를 찾을 수 없습니다: ${id}`);
}

function load(d) {
  const st = JSON.parse(readText(path.join(d, "state.json")));
  st.mode ??= "auto";   // 0.2.x에서 mode 없이 저장된 state는 자동 모드로 읽는다
  st.mode = OLD_MODES[st.mode] ?? st.mode;   // 0.4.x 이전 이름(judge·consensus)으로 저장된 state
  return st;
}

function save(d, st) {
  const tmp = path.join(d, "state.json.tmp");
  writeText(tmp, JSON.stringify(st, null, 2));
  fs.renameSync(tmp, path.join(d, "state.json"));
}

const appendLog = (d, text) => fs.appendFileSync(path.join(d, "log.md"), text + "\n", "utf8");

const RAW_WRITTEN = [];   // 이번 실행에서 저장한 raw 파일 (상태 출력용)
const USAGE_FILE = "usage.jsonl";   // raw/ 안에 호출마다 한 줄씩 토큰 사용량을 쌓는다

function usageLine(d) {
  // 지금까지의 호출 합계를 한 줄로. 기록이 없으면 빈 문자열
  let lines;
  try {
    lines = readText(path.join(d, "raw", USAGE_FILE)).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return "";
  }
  if (!lines.length) return "";
  const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return "토큰: " + WHO.map((w) => {
    const ls = lines.filter((l) => l.who === w);
    const sum = (key) => ls.reduce((a, l) => a + (l[key] ?? 0), 0);
    return `${NAMES[w]} ${ls.length}회 입력 ${k(sum("input"))}(캐시 읽기 ${k(sum("cache_read"))}) 출력 ${k(sum("output"))}`;
  }).join(" · ") + ` (${posix(path.join(d, "raw", USAGE_FILE))})`;
}

async function callStep(st, d, who, tag, prompt, needsJson, validate, lenient = null) {
  /* AI 한 번 호출 → 원문 저장 → 파싱·검사. 형식 오류는 JSON만 한 번 다시 받는다.
     lenient가 있으면 재시도도 실패했을 때 멈추지 않고 lenient(본문, 읽은 JSON 또는 null, 오류)를 돌려준다 */
  const once = async (p, attempt) => {
    const fakeFn = st.mode === "auto" ? fakeAuto : fakeManual;
    const fake = st.dry_run ? () => fakeFn(st, tag, who, attempt) : null;
    let r;
    try {
      r = await ask(who, p, fake);
    } catch (e) {
      if (e.stderr) writeText(path.join(d, "raw", `${tag}_${who}.stderr.txt`), e.stderr);
      throw new Halt(e.message);
    }
    const f = path.join(d, "raw", `${tag}_${who}` + (attempt > 1 ? `.try${attempt}` : "") + ".md");
    writeText(f, r.text);
    RAW_WRITTEN.push(posix(f));   // 진행자가 그대로 링크를 걸 수 있는 경로
    const u = { tag, who, attempt, model: null, input: null, cache_read: null, cache_write: null, output: null, cost_usd: null, ...r.usage, ms: r.ms };
    fs.appendFileSync(path.join(d, "raw", USAGE_FILE), JSON.stringify(u) + "\n", "utf8");
    return r.text;
  };
  const tryValidate = (body, data) => {
    try {
      return [validate(body, data), null];
    } catch (e) {
      if (!(e instanceof FormatError)) throw e;
      return [undefined, e.message];
    }
  };

  const text = await once(prompt, 1);
  let [body, data, err] = splitJson(text, needsJson);
  const first = data;
  if (!err) {
    const [v, e] = tryValidate(body, data);
    if (!e) return v;
    err = e;
  }
  // 원래 프롬프트는 그대로 둬 첫 호출과 접두부가 같게(캐시) 하고, 직전 응답은 JSON 블록만 붙인다.
  // 블록이 없으면 본문에서 JSON을 만들어야 하므로 응답 전체를 붙인다
  const block = [...text.matchAll(JSON_BLOCK_RE)].at(-1);
  const prev = block ? `[너의 직전 응답의 JSON 블록]\n${block[0]}` : `[너의 직전 응답]\n${text}`;
  const retry = `${prompt}\n\n${prev}\n\n[형식 오류]\n${err}\n`
    + "본문은 다시 쓰지 말고, 오류를 고친 ```json 블록 하나만 출력하라.";
  [, data, err] = splitJson(await once(retry, 2), true);
  if (!err) {
    const [v, e] = tryValidate(body, data);   // 본문은 첫 응답의 것을 쓴다
    if (!e) return v;
    err = e;
  }
  if (lenient) return lenient(body, data != null ? data : first, err);
  throw new Halt(`${NAMES[who]} 응답 형식 오류 (재시도 후): ${err}`);
}


// ── 자동 모드 (docs/auto-mode-flow.md) ──────────────────────────────
const STEP_KO = { r1: "R1 독립 답변", draft: "통합 초안", review: "검토", revise: "수정", clean: "정리본" };
const HOW_KO = { applied: "반영", modified: "고쳐 반영", withdrawn: "철회" };

const REVIEW_JSON = `\`\`\`json
{"points": [
  {"id": null, "action": "new", "problem": "...", "grounds": "...", "criterion": "해당 판단 기준",
   "replacement": {"target": "바꿀 부분 인용", "text": "대체 문안"}, "scope": "changed"},
  {"id": "P2", "action": "keep", "grounds": "..."},
  {"id": "P3", "action": "withdraw", "grounds": "..."},
  {"id": "P4", "action": "confirm"}
], "approve": false}
\`\`\`
- 새 지적은 id를 null로 둔다. replacement는 필요할 때만 쓴다.
- scope는 라운드 2부터 쓴다: 직전 수정에서 바뀐 부분이나 그 영향이면 changed, 원래 있던 내용을 놓친 것이면 missed와 놓친 이유(reason).
`;

const REVISE_JSON = `\`\`\`json
{"responses": [
  {"id": "P1", "reply": "accept", "applied": "as_is"},
  {"id": "P2", "reply": "accept", "applied": "modified", "reason": "..."},
  {"id": "P3", "reply": "rebut", "grounds": "..."}
], "edits": [
  {"target": "현재 초안에서 바꿀 원문 구간", "text": "그 자리에 들어갈 새 문안"}
], "full_rewrite": false, "questions": []}
\`\`\`
`;

const QUESTIONS_RULE = "검토자에게 확인받을 미정 사항(남은 쟁점, 검토 요청)은 본문에 적지 말고 JSON의 questions에 한 문장씩 넣어라. "
  + "검토자가 동의하거나 반대 의견을 내야 합의할 수 있다. 없으면 빈 목록으로 둔다.\n";

function parseQuestions(data) {
  const q = data.questions ?? [];
  if (!Array.isArray(q) || !q.every((x) => isStr(x) && x.trim())) throw new FormatError("'questions'는 문자열 목록이어야 합니다");
  return q.map((x) => x.trim());
}

function addQuestions(st, qs, rnd) {
  // 작성자 질문은 수용된 지적처럼 등록한다. 검토자가 confirm(동의) 또는 keep(반대, 근거 필수)으로 답해야 닫힌다.
  // 로그에 덧붙일 질문 목록(P번호 포함)을 돌려준다
  let log = "";
  for (const q of qs) {
    log += `- P${st.next_point}: ${q}\n`;
    st.points[`P${st.next_point}`] = {
      problem: `[작성자 질문] ${q}`, grounds: "작성자가 검토자 확인을 요청함", criterion: "", replacement: null, raised_by: "author",
      status: "accepted", applied: "as_is", closed_how: null, clash: 0,
      history: [{ round: rnd, who: st.author, action: "question", text: q }],
    };
    st.next_point += 1;
  }
  return log ? `\n\n작성자 질문:\n${log}` : "";
}

function header(st, who) {
  const tools = st.workdir
    ? "작업 폴더의 파일은 읽기 도구로 자유롭게 참조하되, 어떤 파일도 수정·생성하지 마라. 근거로 쓴 파일은 경로를 밝혀라. "
    : "도구나 파일을 쓰지 마라. ";
  let s = `너는 ${NAMES[who]}이다. 다른 AI인 ${NAMES[OTHER[who]]}와 아래 주제를 함께 토의해 결론을 찾는다. `
    + `${tools}최종 출력에는 응답만 내라. 한국어로 답하라.\n\n[주제]\n${st.topic}\n`;
  if (st.background) s += `\n[배경]\n${st.background}\n`;
  if (st.requirements.length) {
    // 수동 모드는 요구사항을 {"id", "text", "round"}로 저장한다
    s += "\n[요구사항]\n" + bullets(st.requirements.map((r) => (isDict(r) ? r.text : r)));
  }
  if (st.context) s += `\n[참조 자료]\n${st.context}\n`;
  return s;
}

const lastBy = (p, who) => [...p.history].reverse().find((h) => h.who === who) ?? null;

function pointText(pid, p, extra = "") {
  let s = `- ${pid}: ${p.problem}\n  근거: ${p.grounds}\n`;
  if (p.criterion) s += `  판단 기준: ${p.criterion}\n`;
  if (p.replacement) s += `  대체 문안 (대상: ${p.replacement.target ?? ""})\n  ${p.replacement.text ?? ""}\n`;
  return s + extra;
}

const unresolved = (st) => Object.entries(st.points).filter(([, p]) => p.status !== "closed").map(([pid]) => pid);

function changedSections(prev, cur) {
  // 제목(#~###) 단위로 나눠 직전 초안과 달라진 절의 제목을 돌려준다. 사라진 절은 "(삭제)"를 붙인다
  const split = (t) => {
    const m = new Map();
    let head = "(첫머리)";
    for (const line of t.split("\n")) {
      if (/^#{1,3} /.test(line)) head = line.replace(/^#+ /, "").trim();
      m.set(head, (m.get(head) ?? "") + line + "\n");
    }
    return m;
  };
  const a = split(prev), b = split(cur);
  return [...b].filter(([h, t]) => a.get(h) !== t).map(([h]) => h)
    .concat([...a.keys()].filter((h) => !b.has(h)).map((h) => `${h} (삭제)`));
}

function applyEdits(draft, edits) {
  // 수정 패치를 순서대로 적용한다. target은 그 시점의 초안에서 정확히 한 번 나와야 한다
  if (!Array.isArray(edits)) throw new FormatError("'edits' 목록이 필요합니다 (초안 전체를 다시 썼다면 full_rewrite: true)");
  edits.forEach((e, i) => {
    if (!isDict(e) || !isStr(e.target) || !e.target || !isStr(e.text)) {
      throw new FormatError(`edits[${i}]: target(비어 있지 않은 문자열)과 text(문자열)가 필요합니다`);
    }
    const n = draft.split(e.target).length - 1;
    if (n === 0) throw new FormatError(`edits[${i}]: target이 현재 초안에 없습니다. 초안의 원문을 그대로 옮겨라: ${e.target.slice(0, 60)}`);
    if (n > 1) throw new FormatError(`edits[${i}]: target이 현재 초안에 ${n}번 나옵니다. 앞뒤 문맥을 더 넣어 한 번만 나오게 하라`);
    draft = draft.replace(e.target, () => e.text);
  });
  return draft;
}

function newCap(st) {
  if (st.round === 1) return 5;
  return st.round >= st.max_rounds ? 0 : 2;
}

async function stepR1(st, d) {
  const prompts = Object.fromEntries(WHO.map((w) => [w, header(st, w)
    + "\n[1단계: 독립 답변]\n상대 답을 보지 않은 상태에서 너의 답을 제시하라. "
    + "답을 정할 때 쓴 판단 기준도 정리하라.\n" + JSON_TAIL
    + '```json\n{"criteria": ["판단 기준", "..."]}\n```\n']));

  const validate = (body, data) => {
    const c = data.criteria;
    if (!Array.isArray(c) || !c.length || !c.every((x) => isStr(x) && x.trim())) {
      throw new FormatError("'criteria'는 비어 있지 않은 문자열 목록이어야 합니다");
    }
    return [body, c.map((x) => x.trim())];
  };

  const res = await both(WHO.map((w) => callStep(st, d, w, "r1", prompts[w], true, validate)));
  st.r1 = Object.fromEntries(WHO.map((w) => [w, res[w][0]]));
  st.criteria = Object.fromEntries(WHO.map((w) => [w, res[w][1]]));
  for (const w of WHO) appendLog(d, `\n## R1 · ${NAMES[w]}\n\n${st.r1[w]}\n\n판단 기준:\n${bullets(st.criteria[w])}`);
  st.pending_step = "draft";
  return st;
}

async function stepDraft(st, d) {
  const x = st.author, y = OTHER[st.author];
  const prompt = header(st, x) + "\n[2단계: 통합 초안]\n너는 작성자다. 아래 두 독립 답변을 대등하게 검토해 "
    + `하나의 통합 초안을 써라. 이후 ${NAMES[y]}가 이 초안을 검토하고 지적한다.\n`
    + "초안 첫머리에 '## 판단 기준' 절을 두고 양측 판단 기준을 합친 목록을 적어라. "
    + "기준을 빼거나 합쳤다면 그 이유를 함께 적어라.\n본문에는 초안만 써라. " + QUESTIONS_RULE + "\n"
    + `[너의 독립 답변]\n${st.r1[x]}\n\n[너의 판단 기준]\n${bullets(st.criteria[x])}\n`
    + `[${NAMES[y]}의 독립 답변]\n${st.r1[y]}\n\n`
    + `[${NAMES[y]}의 판단 기준]\n${bullets(st.criteria[y])}`
    + JSON_TAIL + '```json\n{"questions": ["검토자에게 확인받을 미정 사항"]}\n```\n';
  const validate = (body, data) => {
    if (!body) throw new FormatError("본문(초안)이 비어 있습니다");
    return [body, parseQuestions(data)];
  };
  const [draft, qs] = await callStep(st, d, x, "draft", prompt, true, validate);
  st.draft = draft;
  [st.draft_version, st.round, st.pending_step] = [1, 1, "review"];
  appendLog(d, `\n## 초안 v1 · ${NAMES[x]}\n\n${st.draft}` + addQuestions(st, qs, 1));
  return st;
}

async function stepReview(st, d) {
  const x = st.author, y = OTHER[st.author];
  const rnd = st.round, cap = newCap(st);
  const awaiting = Object.entries(st.points).filter(([, p]) => ["accepted", "rebutted"].includes(p.status)).map(([pid]) => pid);

  // 라운드마다 같은 부분(header, 독립 답변, 판단 기준)을 앞에 둬 접두부 캐시가 맞게 한다
  let s = header(st, y)
    + `\n[너의 독립 답변]\n${st.r1[y]}\n\n[너의 판단 기준]\n${bullets(st.criteria[y])}`
    + `\n[${NAMES[x]}의 판단 기준]\n${bullets(st.criteria[x])}`
    + `\n[검토 · 라운드 ${rnd}/${st.max_rounds}]\n너는 검토자다. `
    + `작성자 ${NAMES[x]}가 쓴 초안을 판단 기준에 비춰 검토하라.\n`
    + `\n[현재 초안 v${st.draft_version}]\n${st.draft}\n`;
  if (rnd === 1) {
    s += "\n초안의 판단 기준 처리(제외·병합)에 이의가 있으면 그것도 지적으로 올려라.\n"
      + "초안 전체를 끝까지 검토하고, 지적할 것을 이번에 모두 내라. 다음 라운드부터는 그 사이 바뀐 부분과 그 영향에 대한 지적만 낼 수 있다.\n";
  } else if (cap) {
    const ch = changedSections(st.prev_draft, st.draft);
    s += `\n[직전 수정(v${st.draft_version - 1} → v${st.draft_version})에서 바뀐 절]\n` + (ch.length ? bullets(ch) : "- 없음\n")
      + "새 지적은 바뀐 부분이나 그 영향에 대해서만 낸다(scope: changed). "
      + "1라운드에 냈어야 할, 원래 있던 내용을 놓친 지적이면 scope: missed와 놓친 이유(reason)를 적어라.\n";
  }
  if (awaiting.length) {
    s += "\n[응답할 지적] 아래 지적마다 정확히 한 번씩 응답하라.\n";
    for (const pid of awaiting) {
      const p = st.points[pid], h = lastBy(p, x);
      if (h.action === "question") {
        s += `- ${pid}: ${NAMES[x]}의 질문 — ${h.text}\n  동의하면 confirm, 다른 의견이면 keep(근거 필수)\n`;
        continue;
      }
      const kind = p.status === "accepted" ? "수용" : "반박";
      s += pointText(pid, p, `  ${NAMES[x]}의 응답: ${kind}` + (h.text ? ` — ${h.text}` : "") + "\n");
    }
    s += `- ${NAMES[x]}가 수용한 지적: 초안에 맞게 반영됐으면 confirm, 반영이 부족하면 keep(근거 필수)\n`
      + `- ${NAMES[x]}가 반박한 지적: 반박을 받아들이면 withdraw(어떤 근거로 철회하는지 필수), `
      + "아니면 keep(재반박 필수)\n쉽게 철회하지 말고, 근거가 충분할 때만 철회하라.\n";
  }
  s += cap
    ? `\n새 지적은 최대 ${cap}개까지 낼 수 있다. 새 지적에는 문제, 근거, 해당 판단 기준을 적고, 필요하면 대체 문안을 제시하라.\n`
    : "\n이번이 마지막 라운드이므로 새 지적은 낼 수 없다.\n";
  s += "남은 지적이 없고 새 지적도 없을 때만 approve를 true로 하라.\n" + JSON_TAIL + REVIEW_JSON;

  const validate = (body, data) => {
    const nw = structuredClone(st);
    const pts = data.points;
    if (!Array.isArray(pts) || typeof data.approve !== "boolean") {
      throw new FormatError("'points'(목록)와 'approve'(true/false)가 필요합니다");
    }
    const seen = new Set();
    let added = 0;
    pts.forEach((p, i) => {
      if (!isDict(p)) throw new FormatError(`points[${i}]가 객체가 아닙니다`);
      const act = p.action;
      if (act === "new") {
        added += 1;
        const where = `새 지적 ${added}`;
        const problem = needStr(p, "problem", where), grounds = needStr(p, "grounds", where);
        const rep = p.replacement;
        let scope = null, scopeReason = "";
        if (rnd > 1) {
          scope = p.scope;
          if (!["changed", "missed"].includes(scope)) throw new FormatError(`${where}: scope는 changed 또는 missed여야 합니다`);
          if (scope === "missed") scopeReason = needStr(p, "reason", where);
        }
        const pid = `P${nw.next_point}`;
        nw.next_point += 1;
        nw.points[pid] = {
          problem, grounds,
          criterion: isStr(p.criterion) ? p.criterion : "",
          replacement: isDict(rep) && rep.text ? rep : null,
          ...(scope ? { scope, scope_reason: scopeReason } : {}),
          status: "open", closed_how: null, clash: 0,
          history: [{ round: rnd, who: y, action: "new", text: grounds }],
        };
        return;
      }
      const pid = p.id;
      const cur = isStr(pid) ? own(nw.points, pid) : undefined;
      if (cur == null || cur.status === "closed") throw new FormatError(`${pid}: 없는 지적이거나 이미 종료된 지적입니다`);
      if (seen.has(pid)) throw new FormatError(`${pid}: 두 번 응답했습니다`);
      seen.add(pid);
      const allowed = { accepted: ["confirm", "keep"], rebutted: ["withdraw", "keep"] }[cur.status];
      if (allowed == null) throw new FormatError(`${pid}: ${NAMES[x]}가 응답할 차례인 지적입니다`);
      if (!allowed.includes(act)) throw new FormatError(`${pid}: 이 지적에는 ${allowed.join(" 또는 ")}만 쓸 수 있습니다`);
      const text = act === "confirm" ? "" : needStr(p, "grounds", pid);
      cur.history.push({ round: rnd, who: y, action: act, text });
      if (act === "confirm") {
        cur.status = "closed";
        cur.closed_how = cur.applied === "modified" ? "modified" : "applied";
      } else if (act === "withdraw") {
        [cur.status, cur.closed_how] = ["closed", "withdrawn"];
      } else {
        if (cur.status === "rebutted") cur.clash += 1;
        cur.status = "open";
      }
    });
    if (added > cap) throw new FormatError(`새 지적은 최대 ${cap}개입니다 (${added}개)`);
    const missing = awaiting.filter((pid) => !seen.has(pid));
    if (missing.length) throw new FormatError(`응답하지 않은 지적: ${missing.join(", ")}`);
    const left = unresolved(nw);
    if (data.approve && left.length) throw new FormatError(`남은 지적(${left.join(", ")})이 있는데 approve가 true입니다`);
    if (!data.approve && !left.length) throw new FormatError("남은 지적이 없는데 approve가 false입니다");
    return nw;
  };

  st = await callStep(st, d, y, `r${rnd}_review`, s, true, validate);
  let log = `\n## 라운드 ${rnd} 검토 · ${NAMES[y]}\n`;
  for (const [pid, p] of Object.entries(st.points)) {
    for (const h of p.history) {
      if (h.round === rnd && h.who === y) {
        const isNew = h.action === "new";
        const detail = (isNew ? p.problem + " / " : "") + h.text + (isNew && p.scope_reason ? ` / 놓친 이유: ${p.scope_reason}` : "");
        log += `- ${pid} ${h.action}` + (isNew && p.scope ? ` [${p.scope}]` : "") + (detail ? `: ${detail}` : "") + "\n";
      }
    }
  }
  appendLog(d, log);

  const left = unresolved(st);
  if (!left.length) {
    if (!st.clean_final) return finish(st, d, "합의");
    st.pending_step = "clean";
    return st;
  }
  if (rnd >= st.max_rounds) return finish(st, d, "합의 실패", "최대 라운드 도달");
  if (left.every((pid) => st.points[pid].clash >= 2)) return finish(st, d, "합의 실패", "남은 지적이 모두 교착");
  st.round += 1;
  st.pending_step = "revise";
  return st;
}

async function stepRevise(st, d) {
  const x = st.author, y = OTHER[st.author];
  const rnd = st.round;
  const opens = Object.entries(st.points).filter(([, p]) => p.status === "open").map(([pid]) => pid);

  let s = header(st, x) + `\n[수정 · 라운드 ${rnd}/${st.max_rounds}]\n너는 작성자다. `
    + `검토자 ${NAMES[y]}의 지적에 응답하고 초안을 고쳐라.\n`
    + `\n[현재 초안 v${st.draft_version}]\n${st.draft}\n`
    + "\n[응답할 지적] 아래 지적마다 정확히 한 번씩 응답하라.\n";
  for (const pid of opens) {
    const p = st.points[pid], h = lastBy(p, y);
    s += pointText(pid, p, h.action === "keep" ? `  ${NAMES[y]}의 최신 의견: ${h.text}\n` : "");
  }
  s += "- 수용(accept): 초안에 반영한다. 지적(또는 대체 문안)대로 반영했으면 applied=as_is, "
    + "고쳐서 반영했으면 applied=modified와 이유(reason)\n"
    + "- 반박(rebut): 반영하지 않고 근거(grounds)를 적는다\n"
    + "초안 전체를 다시 쓰지 말고, 바꿀 부분만 edits로 내라. target은 현재 초안에서 정확히 한 번 나오는 원문 구간이고"
    + "(한 번만 나오도록 앞뒤 문맥을 넣는다), text는 그 자리에 들어갈 새 문안이다. edits는 적힌 순서대로 적용된다. "
    + "지적과 관계없는 부분은 바꾸지 마라. 본문에는 지적별 응답 설명만 짧게 써라.\n"
    + "구조가 크게 바뀌어 edits로 나타내기 어려울 때만 full_rewrite를 true로 하고 본문에 수정된 초안 전체를 써라.\n"
    + QUESTIONS_RULE + JSON_TAIL + REVISE_JSON;

  let qlog = "";
  const validate = (body, data) => {
    if (data.full_rewrite === true && !body) throw new FormatError("full_rewrite인데 본문(수정된 초안)이 비어 있습니다");
    const nw = structuredClone(st);
    const rs = data.responses;
    if (!Array.isArray(rs)) throw new FormatError("'responses' 목록이 필요합니다");
    const seen = new Set();
    rs.forEach((r, i) => {
      if (!isDict(r)) throw new FormatError(`responses[${i}]가 객체가 아닙니다`);
      const pid = r.id;
      const cur = isStr(pid) ? own(nw.points, pid) : undefined;
      if (cur == null || cur.status !== "open") throw new FormatError(`${pid}: 응답할 차례인 지적이 아닙니다`);
      if (seen.has(pid)) throw new FormatError(`${pid}: 두 번 응답했습니다`);
      seen.add(pid);
      if (r.reply === "accept") {
        const applied = r.applied;
        if (!["as_is", "modified"].includes(applied)) throw new FormatError(`${pid}: applied는 as_is 또는 modified여야 합니다`);
        const text = applied === "modified" ? needStr(r, "reason", pid) : "";
        [cur.status, cur.applied, cur.clash] = ["accepted", applied, 0];
        cur.history.push({ round: rnd, who: x, action: `accept/${applied}`, text });
      } else if (r.reply === "rebut") {
        const text = needStr(r, "grounds", pid);
        cur.status = "rebutted";
        cur.history.push({ round: rnd, who: x, action: "rebut", text });
      } else {
        throw new FormatError(`${pid}: reply는 accept 또는 rebut여야 합니다`);
      }
    });
    const missing = opens.filter((pid) => !seen.has(pid));
    if (missing.length) throw new FormatError(`응답하지 않은 지적: ${missing.join(", ")}`);
    const draft = data.full_rewrite === true ? body : applyEdits(st.draft, data.edits);
    qlog = addQuestions(nw, parseQuestions(data), rnd);
    nw.prev_draft = st.draft;   // 다음 검토에서 바뀐 절을 알려 주기 위해
    nw.draft = draft;
    nw.draft_version += 1;
    nw.pending_step = "review";
    return nw;
  };

  st = await callStep(st, d, x, `r${rnd}_revise`, s, true, validate);
  let log = `\n## 라운드 ${rnd} 수정 · ${NAMES[x]} (초안 v${st.draft_version})\n`;
  for (const pid of opens) {
    const h = st.points[pid].history.at(-1);
    log += `- ${pid} ${h.action}` + (h.text ? `: ${h.text}` : "") + "\n";
  }
  appendLog(d, log + `\n${st.draft}` + qlog);
  return st;
}

async function stepClean(st, d) {
  // 합의 뒤 작성자가 토의 경과 표현만 뺀 정리본을 만든다. 내용이 바뀌지 않는 정리라 검토자 재확인은 하지 않는다
  const x = st.author;
  const prompt = header(st, x) + "\n[정리본 작성]\n토의가 합의로 끝났다. 아래 합의된 최종 초안을 그대로 쓸 수 있는 문서로 정리하라.\n"
    + "- 결론·수치·범위와 판단 근거 문장은 바꾸지 마라. 내용을 더하거나 빼지 마라.\n"
    + "- 토의 경과 표현만 뺀다: 누가 제안·채택했는지(예: 'Codex 안을 채택'), 몇 라운드·어느 지적(P번호)에 따라 바뀌었는지, "
    + "취소선으로 남긴 옛 문안.\n- 응답에는 정리된 문서 본문만 써라.\n\n"
    + `[합의된 최종 초안 v${st.draft_version}]\n${st.draft}\n`;
  st.clean = await callStep(st, d, x, "clean", prompt, false, (body) => body);
  appendLog(d, `\n## 정리본 · ${NAMES[x]}\n\nfinal.md에 저장했다. 정리 전 초안(v${st.draft_version})은 final_raw.md에 남긴다.`);
  return finish(st, d, "합의");
}

function finish(st, d, result, reason = "") {
  [st.status, st.pending_step] = ["done", null];
  [st.result, st.fail_reason] = [result, reason];
  if (st.clean) writeText(path.join(d, "final_raw.md"), st.draft);
  writeText(path.join(d, "final.md"), st.clean ?? st.draft);
  appendLog(d, "\n" + report(st));
  return st;
}

function report(st) {
  const x = st.author, y = OTHER[st.author];
  let s = `## 결과: ${st.result}` + (st.fail_reason ? ` (${st.fail_reason})` : "") + "\n\n";
  s += `- 작성자: ${NAMES[x]} / 검토자: ${NAMES[y]}\n`
    + (st.clean ? `- 최종본: final.md (정리본) · 정리 전 초안: final_raw.md (v${st.draft_version})\n`
      : `- 최종 초안: final.md (v${st.draft_version})\n`);
  const closed = Object.entries(st.points).filter(([, p]) => p.status === "closed");
  if (closed.length) s += "\n지적 처리:\n" + closed.map(([pid, p]) => `- ${pid} ${HOW_KO[p.closed_how]}: ${p.problem}\n`).join("");
  const missed = Object.entries(st.points).filter(([, p]) => p.scope === "missed").map(([pid]) => pid);
  if (missed.length) s += `\n라운드 2 이후에 나온, 놓친 지적(missed): ${missed.join(", ")}\n`;
  const withdrawn = closed.filter(([, p]) => p.closed_how === "withdrawn");
  s += `\n철회된 지적: ${withdrawn.length}개\n`;
  s += withdrawn.map(([pid, p]) => `- ${pid} 철회 근거: ${lastBy(p, y).text}\n`).join("");
  const left = unresolved(st);
  if (left.length) {
    s += "\n남은 지적:\n";
    for (const pid of left) {
      const p = st.points[pid];
      const hx = lastBy(p, x), hy = lastBy(p, y);
      s += `- ${pid}: ${p.problem}\n`;
      if (hx) s += `  ${NAMES[x]} 마지막 응답 (${hx.action}): ${hx.text}\n`;
      s += `  ${NAMES[y]} 마지막 응답 (${hy.action}): ${hy.text}\n`;
    }
  }
  return s;
}

function printStatus(d, st) {
  const x = st.author, y = OTHER[st.author];
  print(`토의: ${path.basename(d)}  (자동 모드 · 작성자 ${NAMES[x]} / 검토자 ${NAMES[y]})`);
  if (st.status === "done") {
    print(`상태: 종료 · 결과 ${st.result}`);
  } else if (st.status === "halted") {
    print(`상태: 중단 · ${STEP_KO[st.pending_step]} 단계 · 사유: ${st.halt_reason}`);
  } else {
    const who = { r1: "두 AI", draft: NAMES[x], review: NAMES[y], revise: NAMES[x], clean: NAMES[x] }[st.pending_step];
    print(`상태: 진행 중 · 라운드 ${st.round}/${st.max_rounds} · 다음 단계 ${STEP_KO[st.pending_step]} (${who})`);
  }
  const wait = { open: `${NAMES[x]} 응답 대기`, accepted: `${NAMES[y]} 확인 대기(수용됨)`, rebutted: `${NAMES[y]} 응답 대기(반박됨)` };
  for (const [pid, p] of Object.entries(st.points)) {
    const state = p.status === "closed" ? `종료(${HOW_KO[p.closed_how]})` : wait[p.status];
    const stall = p.status === "open" && p.clash >= 2 ? " · 교착" : "";
    print(`  ${pid} ${state}${stall}: ${p.problem}`);
  }
  if (st.last_raw?.length) print("이번 단계 원문: " + st.last_raw.join(", "));
  const used = usageLine(d);
  if (used) print(used);
  if (st.status === "done") {
    print("\n" + report(st));
    print(`기록: ${path.join(d, "log.md")}`);
  } else {
    print(`다음: node discussion.mjs run ${path.basename(d)} --mode auto`);
  }
}

async function runPending(d, st, show = true) {
  WORKDIR = st.workdir;
  MODEL = st.claude_model ?? CLAUDE_MODEL;   // 0.6.x 이전 state에는 없다
  // workdir가 없으면 빈 폴더에서 실행해 진행자 프로젝트의 CLAUDE.md·AGENTS.md가 실리지 않게 한다
  const tmp = WORKDIR ? null : fs.mkdtempSync(path.join(os.tmpdir(), "ai-discussion-"));
  RUN_DIR = WORKDIR || tmp;
  const step = st.pending_step;
  const [steps, stepKo, showFn] = MODES[st.mode];
  [st.status, st.halt_reason] = ["running", null];
  RAW_WRITTEN.length = 0;
  try {
    st = await steps[step](structuredClone(st), d);
  } catch (e) {
    if (!(e instanceof Halt)) throw e;
    [st.status, st.halt_reason] = ["halted", e.message];
    appendLog(d, `\n> 중단 (${stepKo[step]}): ${e.message}\n`);
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
  st.last_raw = [...RAW_WRITTEN];
  save(d, st);
  if (show) showFn(d, st);
  return st;
}

const STEPS = { r1: stepR1, draft: stepDraft, review: stepReview, revise: stepRevise, clean: stepClean };

function fakeAuto(st, tag, who, attempt) {
  // --dry-run 용 가짜 응답. scenario로 합의·교착·최대 라운드·형식 오류·호출 실패를 만든다
  const sc = st.scenario, rnd = st.round, pts = st.points;
  if (tag === "r1") {
    const crit = { criteria: [`${NAMES[who]} 기준`, "비용"] };
    return `(${NAMES[who]}) 독립 답변\n\n\`\`\`json\n${JSON.stringify(crit)}\n\`\`\``;
  }
  if (tag === "draft") {
    const questions = sc === "question" ? ["가짜 작성자 질문"] : [];
    return `## 판단 기준\n- 비용\n\n(${NAMES[who]}) 통합 초안 v1\n\n\`\`\`json\n${JSON.stringify({ questions })}\n\`\`\``;
  }
  if (tag === "clean") return `## 판단 기준\n- 비용\n\n(${NAMES[who]}) 정리본`;
  if (tag.endsWith("review")) {
    if (sc === "callfail") throw new Error("가짜 호출 실패");
    if (rnd === 1 && (sc === "format_halt" || (sc === "format" && attempt === 1))) {
      return '검토 의견\n\n```json\n{"points": [\n```';
    }
    let out = [];
    for (const [pid, p] of Object.entries(pts)) {
      if (sc === "question" && p.raised_by === "author" && attempt === 1) continue;   // 첫 시도는 작성자 질문을 빠뜨린다
      if (p.status === "accepted") out.push({ id: pid, action: sc === "maxround" ? "keep" : "confirm", grounds: "가짜 근거" });
      else if (p.status === "rebutted") out.push({ id: pid, action: sc === "stall" ? "keep" : "withdraw", grounds: "가짜 근거" });
    }
    if (sc === "late_point" && rnd === 2) {   // 첫 시도는 scope를 빠뜨려 형식 오류를 낸다
      out.push({ id: null, action: "new", problem: "늦게 나온 문제", grounds: "가짜 근거", criterion: "비용",
        ...(attempt > 1 ? { scope: "missed", reason: "가짜 놓친 이유" } : {}) });
    }
    if (rnd === 1) {
      const n = ["stall", "maxround"].includes(sc) ? 1 : 2;
      out = out.concat(Array.from({ length: n }, (_, i) =>
        ({ id: null, action: "new", problem: `가짜 문제 ${i + 1}`, grounds: "가짜 근거", criterion: "비용" })));
    }
    let approve = out.every((o) => ["confirm", "withdraw"].includes(o.action));
    if (sc === "badapprove" && rnd === 1 && attempt === 1) approve = true;
    return `검토 의견\n\n\`\`\`json\n${JSON.stringify({ points: out, approve })}\n\`\`\``;
  }
  const rs = [], v = st.draft_version;
  Object.entries(pts).filter(([, p]) => p.status === "open").forEach(([pid], i) => {
    if (sc === "stall" || (sc !== "maxround" && i % 2 === 1)) rs.push({ id: pid, reply: "rebut", grounds: "가짜 반박" });
    else if (sc === "maxround") rs.push({ id: pid, reply: "accept", applied: "modified", reason: "가짜 사유" });
    else rs.push({ id: pid, reply: "accept", applied: "as_is" });
  });
  // maxround는 전체 다시 쓰기, 나머지는 패치. patch_miss는 2라운드 첫 시도에 초안에 없는 target을 낸다
  if (sc === "maxround") {
    return `## 판단 기준\n- 비용\n\n(${NAMES[who]}) 통합 초안 v${v + 1}\n\n`
      + `\`\`\`json\n${JSON.stringify({ responses: rs, full_rewrite: true })}\n\`\`\``;
  }
  const target = sc === "patch_miss" && rnd === 2 && attempt === 1 ? "초안에 없는 문구" : `통합 초안 v${v}`;
  const edits = [{ target, text: `통합 초안 v${v + 1}` }];
  return `지적별 응답 설명\n\n\`\`\`json\n${JSON.stringify({ responses: rs, edits })}\n\`\`\``;
}

// wording·converge는 수동 모드 전용, badapprove·late_point·patch_miss·question은 자동 모드 전용. format_halt는 수동 모드에서 누락 처리가 된다
const SCENARIOS = ["agree", "stall", "maxround", "format", "format_halt", "badapprove", "callfail", "wording", "converge",
  "late_point", "patch_miss", "question"];

function nextAuthor() {
  // 토의마다 첫 작성자를 번갈아 정한다 (직전 자동 모드 토의의 반대쪽)
  let last = null;
  for (const d of listDiscussions()) {
    let s;
    try {
      s = load(d);
    } catch {
      continue;
    }
    if (s.mode === "auto") last = s.author ?? null;
  }
  return has(OTHER, last) ? OTHER[last] : "claude";
}


// ── 수동 모드 (docs/manual-mode-flow.md) ────────────────────────────
const J_STEP_KO = { r1: "R1 독립 답변", r2: "R2 쟁점표 확인", round: "쟁점 공방", final_review: "최종안 검토" };
const PHASE_KO = { draft: "쟁점표 초안", baseline: "쟁점표 확정", discussion: "쟁점 공방", final: "최종안", done: "종료" };
const KIND_KO = { issue: "쟁점", agree_candidate: "합의 후보", one_sided: "한쪽 항목" };
const ITEM_KO = {
  open: "논의 중", agreed: "합의", user_decided: "사용자 판정", stall_candidate: "교착 후보",
  deferred: "보류", unverified: "미확인", excluded: "제외", wording_conflict: "표현 충돌",
};
const ONE_SIDED = ["agree", "disagree", "insufficient", "irrelevant"];
const UNRESOLVED = ["open", "stall_candidate", "wording_conflict"];
const CHECKS = ["agreements", "user_decisions", "unresolved_listed", "no_new_conclusions"];
const PHASE_CMDS = {
  draft: ["edit", "next", "req", "end"],
  baseline: ["edit", "pick-wording", "next", "note", "req", "exclude", "final", "end"],
  discussion: ["next", "judge", "judge-all", "note", "req", "defer", "exclude", "proposal", "reopen", "edit",
    "final-draft", "final", "end"],
  final: ["final-draft", "final", "final-fix", "judge", "reopen", "edit", "confirm", "end"],
  done: [],
};
const CMD_USAGE = {
  edit: "edit {id} --file ops.json",
  next: "next {id}",
  judge: 'judge {id} <항목> claude|codex  /  judge {id} <항목> --text "..."',
  "judge-all": "judge-all {id} claude|codex",
  note: 'note {id} <항목|all> "..."',
  req: 'req {id} "..."',
  defer: "defer {id} <항목>",
  exclude: 'exclude {id} <항목> ["사유"]',
  "pick-wording": "pick-wording {id} <항목> claude|codex",
  proposal: "proposal {id} <N번호> accept|reject",
  reopen: "reopen {id} <항목>",
  "final-draft": "final-draft {id}",
  final: "final {id} --file draft.md",
  "final-fix": "final-fix {id} --file draft.md",
  confirm: "confirm {id}",
  end: "end {id}",
};

const R2_JSON = `\`\`\`json
{"items": [
  {"id": "I1", "wording": "ok", "position": "...", "grounds": "...",
   "rebuttal": "(선택) 상대 독립 답변의 어떤 주장과 어떻게 다른지"},
  {"id": "I2", "wording": {"revise": "수정한 질문", "reason": "..."}, "position": "(선택) 수정안 기준 입장"},
  {"id": "A1", "confirm": true, "note": "(선택) 동의하며 붙이는 전제·한정"},
  {"id": "A2", "confirm": false, "reason": "..."},
  {"id": "S1", "response": "agree | disagree | insufficient | irrelevant", "reason": "...",
   "note": "(agree일 때 선택) 동의하며 붙이는 전제·한정"}
], "missing_issues": [{"question": "...", "reason": "..."}]}
\`\`\`
`;

const FINAL_JSON = `\`\`\`json
{"checks": {"agreements": "ok | problem", "user_decisions": "ok | problem",
            "unresolved_listed": "ok | problem", "no_new_conclusions": "ok | problem"},
 "points": [{"type": "wording | assembly | substance", "item": "I3", "problem": "...", "suggestion": "..."}]}
\`\`\`
`;
const POINT_KO = { wording: "표현", assembly: "조립", substance: "실질" };
const STANCE_KO = { hold: "유지", change: "변경", withdraw: "철회" };

function roundExample(st, who, rnd, ids) {
  // R3 이후 JSON 예시. 쟁점마다 실제로 써야 하는 필드만 넣는다
  const o = OTHER[who], rows = [];
  for (const iid of ids) {
    const it = st.items[iid], r = { id: iid };
    if (it.wording_changed_round === rnd - 1) r.prior_rebuttal_valid = true;
    if (it.last_rebuttal[o]) Object.assign(r, { responds_to: "상대 지적의 요지", reply: "accept | counter", grounds: "..." });
    if (has(it.positions, who)) {
      Object.assign(r, { stance: "hold | change | withdraw", position: "(change일 때 필수, hold일 때 선택) 입장 문장 전체" });
    } else {
      Object.assign(r, { stance: "change", position: "너의 입장" });
    }
    if (has(it.positions, o)) r.rebuttal = "(선택) 상대 현재 입장에 남은 차이나 문제. 없으면 빈 문자열";
    r.stall = null;
    rows.push(r);
  }
  const items = rows.map((r) => JSON.stringify(r)).join(",\n  ");
  return '```json\n{"items": [\n  ' + items + '\n], "new_issues": '
    + '[{"question": "...", "grounds": "...", "impact": "결론에 미치는 영향"}]}\n```\n';
}

const optStr = (obj, key) => (isStr(obj[key]) ? obj[key].trim() : "");

function newItem(kind, text, origin, owner = null) {
  const it = {
    kind, origin, text, status: "open",
    wording_changed_round: null, wording_proposals: {},
    positions: {}, last_rebuttal: {},
    keep_streak: { claude: 0, codex: 0 }, missing: { claude: 0, codex: 0 },
    stall_reason: null, user_note: null, resolution: null, reason: null,
    notes: {}, converge: null,
  };
  if (owner) it.owner = owner;
  return it;
}

function addItem(st, prefix, item) {
  const iid = `${prefix}${st.next_id[prefix]}`;
  st.next_id[prefix] += 1;
  st.items[iid] = item;
  return iid;
}

function originOf(bys) {
  // 제안한 쪽들을 하나로. 양쪽이 섞이면 both
  const s = new Set(bys);
  return s.size === 1 ? [...s][0] : "both";
}

const whoKo = (w) => (has(NAMES, w) ? NAMES[w] : "양측");

const openIssues = (st) => Object.entries(st.items).filter(([, it]) => it.status === "open").map(([iid]) => iid);

function stall(it, reason) {
  [it.status, it.stall_reason] = ["stall_candidate", reason];
}

function deferUnresolved(st, reason) {
  const moved = Object.entries(st.items).filter(([, it]) => UNRESOLVED.includes(it.status)).map(([iid]) => iid);
  for (const iid of moved) [st.items[iid].status, st.items[iid].reason] = ["deferred", reason];
  return moved;
}

function parseItems(data, expected, parseOne, strict) {
  /* 항목별 응답 검사 → [통과한 응답, 누락 ID].
     strict면 오류가 하나라도 있으면 FormatError. 아니면 통과한 항목만 남기고 나머지는 누락으로 본다 */
  const got = {}, errors = [];
  let rows = data != null ? data.items : [];
  if (!Array.isArray(rows)) {
    errors.push("'items' 목록이 필요합니다");
    rows = [];
  }
  rows.forEach((r, i) => {
    const iid = isDict(r) ? r.id : null;
    if (!expected.includes(iid)) {
      errors.push(`items[${i}]: 응답할 항목이 아닙니다 (${iid})`);
    } else if (has(got, iid)) {
      errors.push(`${iid}: 두 번 응답했습니다`);
    } else {
      try {
        got[iid] = parseOne(iid, r);
      } catch (e) {
        if (!(e instanceof FormatError)) throw e;
        errors.push(e.message);
      }
    }
  });
  const missing = expected.filter((iid) => !has(got, iid));
  if (strict) {
    if (missing.length) errors.push(`응답하지 않았거나 형식이 틀린 항목: ${missing.join(", ")}`);
    if (errors.length) throw new FormatError([...new Set(errors)].join("; "));
  }
  return [got, missing];
}

function parseList(data, key, fields, cap, strict) {
  // missing_issues·new_issues 검사. 필드가 없으면 빈 목록으로 본다
  const rows = data?.[key] ?? [];
  if (!Array.isArray(rows)) {
    if (strict) throw new FormatError(`'${key}'는 목록이어야 합니다`);
    return [];
  }
  let out = [];
  rows.forEach((r, i) => {
    try {
      if (!isDict(r)) throw new FormatError(`${key}[${i}]가 객체가 아닙니다`);
      out.push(Object.fromEntries(fields.map((f) => [f, needStr(r, f, `${key}[${i}]`)])));
    } catch (e) {
      if (!(e instanceof FormatError) || strict) throw e;
    }
  });
  if (cap != null && out.length > cap) {
    if (strict) throw new FormatError(`${key}는 최대 ${cap}개입니다 (${out.length}개)`);
    out = out.slice(0, cap);
  }
  return out;
}

function jBoth(st, d, tag, prompts, make) {
  /* 두 AI를 동시에 부른다. make(who, strict)가 검사 함수를 만든다.
     형식 오류 재시도까지 실패하면 멈추지 않고 strict=false 검사로 누락 처리한다 */
  return both(WHO.map((w) => callStep(st, d, w, tag, prompts[w], true, make(w, true), make(w, false))));
}

function posText(it, w) {
  const p = own(it.positions, w);
  if (!p) return "(아직 없음)";
  return p.text + (p.grounds ? `\n  근거: ${p.grounds}` : "");
}

function howText(r) {
  // resolution이 어떻게 정해졌는지
  switch (r.by) {
    case "agreement": return "양측 확인";
    case "withdraw": return `${whoKo(r.who)} 철회`;
    case "moderator": return "진행자 판단 합의";
    case "user": return "사용자 판정" + (r.who ? `, ${NAMES[r.who]} 쪽` : "");
  }
  throw new Error(`알 수 없는 결론 방식: ${r.by}`);
}

function notesLines(it, indent) {
  // 합의하며 붙인 단서 (예전 상태 파일에는 notes가 없다)
  return Object.entries(it.notes ?? {}).map(([w, n]) => `${indent}단서(${NAMES[w]}): ${n}`);
}

function concludedText(st) {
  let lines = [];
  for (const [iid, it] of Object.entries(st.items)) {
    const s = it.status;
    if (["agreed", "user_decided"].includes(s)) lines.push(`- ${iid} (${ITEM_KO[s]}): ${it.text}\n  결론: ${it.resolution.text}`);
    else if (["unverified", "deferred"].includes(s)) lines.push(`- ${iid} (${ITEM_KO[s]}): ${it.text}`);
    else continue;
    lines = lines.concat(notesLines(it, "  "));
  }
  return lines.join("\n") || "(없음)";
}

function tableText(st) {
  let out = [];
  for (const [iid, it] of Object.entries(st.items)) {
    const s = it.status;
    const kind = KIND_KO[it.kind] + (it.kind === "one_sided" ? `(${NAMES[it.owner]})` : "");
    out.push(`- ${iid} [${kind} · ${ITEM_KO[s]}] ${it.text}`);
    const r = it.resolution;
    if (r) {
      out.push(`    결론 (${howText(r)}, R${r.round}): ${r.text}`);
      if (r.reason) out.push(`    진행자 판단 근거: ${r.reason}`);
    }
    out = out.concat(notesLines(it, "    "));
    if (it.reason) out.push(`    사유: ${it.reason}`);
    if (s === "stall_candidate") out.push(`    교착 사유: ${it.stall_reason}`);
    if (UNRESOLVED.includes(s) || s === "deferred") {
      for (const w of WHO) {
        if (has(it.positions, w)) {
          const text = posText(it, w).replaceAll("\n", "\n      ");
          out.push(`    ${NAMES[w]} 입장 (R${it.positions[w].round}): ${text}`);
        }
      }
      for (const w of WHO) {
        if (it.last_rebuttal[w]) out.push(`    ${NAMES[w]}의 남은 차이 지적: ${it.last_rebuttal[w]}`);
      }
      if (it.converge) {
        out.push(`    수렴 신호 (R${it.converge.round}): ${it.converge.signals.join(", ")} → 진행자 판단 필요 (edit op converge)`);
      }
      for (const [w, p] of Object.entries(it.wording_proposals)) {
        out.push(`    ${NAMES[w]} 표현 수정안: ${p.revise} (이유: ${p.reason})`);
      }
      if (it.user_note) out.push(`    다음 라운드 사용자 의견: ${it.user_note}`);
      const counts = WHO.map((w) => `${NAMES[w]} 유지 ${it.keep_streak[w]}연속·누락 ${it.missing[w]}`);
      if (Object.values(it.keep_streak).some(Boolean) || Object.values(it.missing).some(Boolean)) {
        out.push("    " + counts.join(" / "));
      }
    }
  }
  return out.join("\n") || "(항목 없음)";
}


// ── 수동 모드: AI 단계 ───────────────────────────────────────────────
async function jstepR1(st, d) {
  const prompt = Object.fromEntries(WHO.map((w) => [w,
    header(st, w) + "\n[1단계: 독립 답변]\n상대 답을 보지 않은 상태에서 너의 답을 근거와 함께 제시하라.\n"]));
  st.r1 = await both(WHO.map((w) => callStep(st, d, w, "r1", prompt[w], false, (body) => body)));
  for (const w of WHO) appendLog(d, `\n## R1 · ${NAMES[w]}\n\n${st.r1[w]}`);
  [st.round, st.pending_step] = [1, "r2"];
  return st;
}

const r2Expected = (st, who) =>
  Object.entries(st.items).filter(([, it]) => !(it.kind === "one_sided" && it.owner === who)).map(([iid]) => iid);

function parseR2Item(st, iid, r) {
  const kind = st.items[iid].kind;
  if (kind === "issue") {
    const w = r.wording;
    if (w === "ok") {
      return {
        wording: "ok", position: needStr(r, "position", iid),
        grounds: needStr(r, "grounds", iid), rebuttal: optStr(r, "rebuttal"),
      };
    }
    if (isDict(w)) {
      return {
        wording: { revise: needStr(w, "revise", iid), reason: needStr(w, "reason", iid) },
        position: optStr(r, "position"), grounds: optStr(r, "grounds"), rebuttal: optStr(r, "rebuttal"),
      };
    }
    throw new FormatError(`${iid}: wording은 "ok" 또는 {"revise", "reason"} 객체여야 합니다`);
  }
  if (kind === "agree_candidate") {
    if (r.confirm === true) return { confirm: true, note: optStr(r, "note") };
    if (r.confirm === false) return { confirm: false, reason: needStr(r, "reason", iid) };
    throw new FormatError(`${iid}: confirm은 true 또는 false여야 합니다`);
  }
  const resp = r.response;
  if (!ONE_SIDED.includes(resp)) throw new FormatError(`${iid}: response는 ${ONE_SIDED.join(" / ")} 중 하나여야 합니다`);
  return {
    response: resp, reason: resp === "agree" ? optStr(r, "reason") : needStr(r, "reason", iid),
    note: resp === "agree" ? optStr(r, "note") : "",
  };
}

async function jstepR2(st, d) {
  const prompt = (who) => {
    const o = OTHER[who];
    let s = header(st, who) + `\n[2단계: 쟁점표 확인 · 라운드 2/${st.max_rounds}]\n`
      + "진행자가 두 독립 답변을 보고 쟁점표 초안을 만들었다. 진행자는 쟁점의 질문만 적었고 양측 입장은 적지 않았다.\n"
      + `\n[너의 독립 답변]\n${st.r1[who]}\n\n[${NAMES[o]}의 독립 답변]\n${st.r1[o]}\n\n[쟁점표 초안]\n`;
    const groups = [
      ["쟁점", (it) => it.kind === "issue"],
      ["합의 후보 (양측이 모두 확인해야 합의가 된다)", (it) => it.kind === "agree_candidate"],
      [`${NAMES[o]}만 다룬 항목 (네가 분류한다)`, (it) => it.kind === "one_sided" && it.owner === o],
    ];
    for (const [title, f] of groups) {
      const rows = Object.entries(st.items).filter(([, it]) => f(it)).map(([iid, it]) => `- ${iid}: ${it.text}\n`);
      if (rows.length) s += `${title}\n` + rows.join("");
    }
    const mine = Object.entries(st.items).filter(([, it]) => it.kind === "one_sided" && it.owner === who).map(([iid]) => iid);
    if (mine.length) s += `(너만 다룬 항목 ${mine.join(", ")}는 ${NAMES[o]}가 분류하므로 응답하지 마라)\n`;
    s += "\n- 쟁점: 질문 표현부터 확인하라. 정확하면 wording을 \"ok\"로 두고 너의 입장(position), 근거(grounds), "
      + `${NAMES[o]} 독립 답변과 다른 점(rebuttal: 상대의 어떤 주장과 어떻게 다른지)을 적어라. `
      + "다른 점이 없으면 rebuttal은 비워 둔다. "
      + "표현이 부정확하면 wording에 수정한 질문(revise)과 이유(reason)를 적어라. 이때 입장은 선택이다.\n"
      + "- 합의 후보: 실제로 같은 의견이면 confirm을 true로, 아니면 false와 이유(reason)를 적어라. "
      + "동의하되 전제나 한정을 붙인다면 note에 적어라.\n"
      + `- ${NAMES[o]}만 다룬 항목: agree(동의) / disagree(반대) / insufficient(근거 부족) / `
      + "irrelevant(주제와 무관) 중 하나로 분류하라. agree가 아니면 reason이 필요하다. "
      + "agree에 전제나 한정을 붙인다면 note에 적어라.\n"
      + "- 쟁점표에 빠진 쟁점이 있으면 missing_issues에 질문과 이유를 적어라.\n"
      + "응답하라고 한 항목 ID마다 정확히 한 번씩 응답하라. 본문에는 너의 논증을 자유롭게 써라.\n"
      + JSON_TAIL + R2_JSON;
    return s;
  };

  const make = (who, strict) => (body, data, err = null) => {
    const [got, miss] = parseItems(data, r2Expected(st, who), (iid, r) => parseR2Item(st, iid, r), strict);
    const mi = parseList(data, "missing_issues", ["question", "reason"], null, strict);
    return { body, items: got, missing: miss, missing_issues: mi, error: err };
  };

  const res = await jBoth(st, d, "r2", Object.fromEntries(WHO.map((w) => [w, prompt(w)])), make);
  let log = "";
  for (const w of WHO) {
    log += `\n## R2 · ${NAMES[w]}\n\n${res[w].body}\n`;
    if (res[w].error) log += `\n> 형식 오류 (재시도 후): ${res[w].error} → 누락: ${res[w].missing.join(", ") || "없음"}\n`;
  }
  log += "\n### R2 처리\n";
  for (const [iid, it] of Object.entries(st.items)) {
    const r = Object.fromEntries(WHO.map((w) => [w, own(res[w].items, iid) ?? null]));
    if (it.kind === "issue") {
      for (const w of WHO) {
        const x = r[w];
        if (x == null) {
          it.missing[w] += 1;
          continue;
        }
        if (x.position) it.positions[w] = { text: x.position, grounds: x.grounds, stance: null, round: 2 };
        if (x.rebuttal) it.last_rebuttal[w] = x.rebuttal;
        if (x.wording !== "ok") it.wording_proposals[w] = x.wording;
      }
      const props = it.wording_proposals;
      if (Object.keys(props).length === 2 && props.claude.revise !== props.codex.revise) {
        it.status = "wording_conflict";
        log += `- ${iid}: 양측이 서로 다른 표현 수정안 → 표현 충돌\n`;
      } else if (!isEmpty(props)) {
        log += `- ${iid}: 표현 수정안 (${Object.keys(props).map((w) => NAMES[w]).join(", ")}) → 진행자 반영 대기\n`;
      }
    } else if (it.kind === "agree_candidate") {
      const objs = WHO.filter((w) => !(r[w] && r[w].confirm));
      if (!objs.length) {
        it.status = "agreed";
        it.resolution = { by: "agreement", text: it.text, round: 2 };
        it.notes = Object.fromEntries(WHO.filter((w) => r[w].note).map((w) => [w, r[w].note]));
        log += `- ${iid}: 양측 확인 → 합의` + (!isEmpty(it.notes) ? " (단서 있음)" : "") + "\n";
        continue;
      }
      it.kind = "issue";
      for (const w of objs) {
        if (r[w]) it.last_rebuttal[w] = r[w].reason;
        else it.missing[w] += 1;
      }
      it.reason = objs.map((w) => `${NAMES[w]} ` + (r[w] ? `이의: ${r[w].reason}` : "응답 누락")).join(" / ");
      log += `- ${iid}: 합의 후보 → 쟁점 (${it.reason})\n`;
    } else {
      const w = OTHER[it.owner];
      const x = r[w];
      if (x == null || x.response === "disagree") {
        it.kind = "issue";
        if (x == null) {
          it.missing[w] += 1;
          it.reason = `${NAMES[w]} 응답 누락`;
        } else {
          [it.last_rebuttal[w], it.reason] = [x.reason, `${NAMES[w]} 반대: ${x.reason}`];
        }
        log += `- ${iid}: 한쪽 항목 → 쟁점 (${it.reason})\n`;
        continue;
      }
      it.reason = x.reason || null;
      if (x.response === "agree") {
        it.status = "agreed";
        it.resolution = { by: "agreement", text: it.text, round: 2 };
        if (x.note) it.notes = { [w]: x.note };
      } else {
        it.status = x.response === "insufficient" ? "unverified" : "excluded";
      }
      log += `- ${iid}: ${NAMES[w]} ${x.response} → ${ITEM_KO[it.status]}` + (x.reason ? ` (사유: ${x.reason})` : "") + "\n";
    }
  }
  for (const w of WHO) {
    for (const m of res[w].missing_issues) {
      const mid = `M${st.next_id.M}`;
      st.next_id.M += 1;
      st.missing_issues.push({ id: mid, by: w, ...m, handled: null });
      log += `- ${mid} 빠진 쟁점 제안 (${NAMES[w]}): ${m.question} / 이유: ${m.reason}\n`;
    }
  }
  appendLog(d, log);
  const mark = "### R2 처리\n";
  st.last_summary = log.slice(log.indexOf(mark) + mark.length).trimEnd().split("\n");
  [st.round, st.phase, st.pending_step] = [2, "baseline", "round"];
  return st;
}

function parseRoundItem(st, who, rnd) {
  const o = OTHER[who];
  return (iid, r) => {
    const it = st.items[iid], out = {};
    if (it.wording_changed_round === rnd - 1) {
      if (typeof r.prior_rebuttal_valid !== "boolean") {
        throw new FormatError(`${iid}: 표현이 바뀐 쟁점이라 prior_rebuttal_valid(true/false)가 필요합니다`);
      }
      out.prior_rebuttal_valid = r.prior_rebuttal_valid;
    }
    out.reply = null;
    if (it.last_rebuttal[o]) {
      if (!["accept", "counter"].includes(r.reply)) throw new FormatError(`${iid}: reply는 accept 또는 counter여야 합니다`);
      const respondsTo = needStr(r, "responds_to", iid);
      Object.assign(out, { responds_to: respondsTo, reply: r.reply, grounds: needStr(r, "grounds", iid) });
    }
    const stance = r.stance;
    if (!has(STANCE_KO, stance)) throw new FormatError(`${iid}: stance는 ${Object.keys(STANCE_KO).join(" / ")} 중 하나여야 합니다`);
    if (stance === "hold" && !has(it.positions, who)) {
      throw new FormatError(`${iid}: 아직 입장이 없어 hold를 쓸 수 없습니다. change로 입장을 적어라`);
    }
    if (stance === "withdraw" && !has(it.positions, o)) {
      throw new FormatError(`${iid}: ${NAMES[o]}의 입장이 아직 없어 withdraw를 쓸 수 없습니다`);
    }
    out.stance = stance;
    // hold는 주장 내용 유지: 표현을 다듬은 문장이 있으면 받아서 입장 문장을 바꾼다
    out.position = stance === "change" ? needStr(r, "position", iid) : stance === "hold" ? optStr(r, "position") : "";
    out.note = stance === "withdraw" ? optStr(r, "note") : "";
    out.rebuttal = optStr(r, "rebuttal");   // 남은 차이가 없으면 비울 수 있다
    out.stall = optStr(r, "stall") || null;
    return out;
  };
}

async function jstepRound(st, d) {
  const rnd = st.round + 1, ids = openIssues(st);

  const prompt = (who) => {
    const o = OTHER[who];
    let s = header(st, who) + `\n[쟁점 공방 · 라운드 ${rnd}/${st.max_rounds}]\n`
      + `아래 미해결 쟁점마다 ${NAMES[o]}가 지적한 차이에 답하고, 두 입장의 차이를 좁혀 결론을 찾아라. `
      + "이기려고 하지 말고, 맞는 지적은 받아들여라.\n"
      + `\n[합의점과 확정된 결론]\n${concludedText(st)}\n\n[미해결 쟁점]\n`;
    for (const iid of ids) {
      const it = st.items[iid];
      s += `\n### ${iid}: ${it.text}\n`;
      if (it.wording_changed_round === rnd - 1) {
        s += "(지난 라운드에 질문 표현이 바뀌었다. 기존 지적이 아직 유효한지 prior_rebuttal_valid로 밝혀라)\n";
      }
      s += `- 너의 현재 입장: ${posText(it, who)}\n- ${NAMES[o]}의 현재 입장: ${posText(it, o)}\n`
        + `- ${NAMES[o]}가 지적한 남은 차이: ${it.last_rebuttal[o] || "(없음)"}\n`;
      if (it.user_note) s += `- 사용자 의견 (반드시 반영): ${it.user_note}\n`;
    }
    if (st.note_all) s += `\n[사용자 의견 — 모든 쟁점에 반영]\n${st.note_all}\n`;
    s += `\n- ${NAMES[o]}가 지적한 차이가 있으면 responds_to(어떤 지적에 답하는지 요지), `
      + "reply(accept: 그 지적을 받아들임 / counter: 받아들이지 않음), grounds(근거)를 적어라.\n"
      + "- stance: hold(주장 내용 유지. 표현만 다듬었으면 다듬은 문장 전체를 position에 적는다) / "
      + "change(주장 내용을 바꿈. position에 새 입장 전체) / withdraw(철회: 상대 현재 입장을 받아들임. "
      + "받아들이며 붙이는 전제·한정이 있으면 note에 적는다). 입장이 아직 없으면 change로 입장을 적어라.\n"
      + "- rebuttal: 상대 현재 입장에 아직 남은 차이나 문제. 차이가 없으면 빈 문자열로 둔다.\n"
      + "- stall: 더 공방해도 결론이 나지 않는다고 보면 그 사유를 적어라. 아니면 null.\n"
      + "- new_issues: 결론에 영향을 주는데 쟁점표에 없는 쟁점 (최대 2개). 질문(question), 근거(grounds), "
      + "결론에 미치는 영향(impact)을 적어라. 바로 공방에 넣지 않고 사용자가 추가 여부를 정한다.\n"
      + "위 쟁점 ID마다 정확히 한 번씩 응답하라. 본문에는 쟁점별 논증을 자유롭게 써라.\n"
      + JSON_TAIL + roundExample(st, who, rnd, ids);
    return s;
  };

  const make = (who, strict) => (body, data, err = null) => {
    const [got, miss] = parseItems(data, ids, parseRoundItem(st, who, rnd), strict);
    const nw = parseList(data, "new_issues", ["question", "grounds", "impact"], 2, strict);
    return { body, items: got, missing: miss, new: nw, error: err };
  };

  const res = await jBoth(st, d, `r${rnd}`, Object.fromEntries(WHO.map((w) => [w, prompt(w)])), make);
  let log = `\n## 라운드 ${rnd}\n`;
  for (const w of WHO) {
    log += `\n### ${NAMES[w]}\n\n${res[w].body}\n`;
    if (res[w].error) log += `\n> 형식 오류 (재시도 후): ${res[w].error} → 누락: ${res[w].missing.join(", ") || "없음"}\n`;
  }
  log += `\n### 라운드 ${rnd} 처리\n`;
  for (const iid of ids) {
    const it = st.items[iid];
    const r = Object.fromEntries(WHO.map((w) => [w, own(res[w].items, iid) ?? null]));
    const had = WHO.every((w) => has(it.positions, w));   // 첫 입장을 쓴 것은 수정으로 보지 않는다
    for (const w of WHO) {
      const x = r[w];
      if (x == null) {
        it.missing[w] += 1;
        continue;
      }
      if (x.stance === "change") {
        it.positions[w] = { text: x.position, stance: "change", round: rnd };
        it.keep_streak[w] = 0;
      } else if (has(it.positions, w)) {
        it.positions[w].stance = x.stance;
        if (x.stance === "hold") {
          it.keep_streak[w] += 1;
          if (x.position) Object.assign(it.positions[w], { text: x.position, round: rnd });
        }
      }
      // 이번에 남은 차이를 적지 않았으면 지난 지적은 해소된 것으로 본다
      if (x.rebuttal) it.last_rebuttal[w] = x.rebuttal;
      else delete it.last_rebuttal[w];
    }
    [it.user_note, it.converge] = [null, null];
    const wd = WHO.filter((w) => r[w] && r[w].stance === "withdraw");
    if (wd.length === 2) {
      stall(it, "양측이 모두 철회 (서로 상대 안을 받아들임)");
    } else if (wd.length) {
      const winner = OTHER[wd[0]];
      it.status = "agreed";
      it.resolution = { by: "withdraw", who: wd[0], text: it.positions[winner].text, round: rnd };
      if (r[wd[0]].note) (it.notes ??= {})[wd[0]] = r[wd[0]].note;
    } else {
      let reasons = WHO.every((w) => it.keep_streak[w] >= 2) ? ["양측 2라운드 연속 유지"] : [];
      reasons = reasons.concat(WHO.filter((w) => r[w] && r[w].stall).map((w) => `${NAMES[w]}: ${r[w].stall}`));
      reasons = reasons.concat(WHO.filter((w) => it.missing[w] >= 2).map((w) => `${NAMES[w]} 응답 누락 반복`));
      if (reasons.length) stall(it, reasons.join("; "));
      // 수렴 신호: 스크립트는 닫지 않고, 진행자가 converge op로 판단한다
      const signals = [
        ...(WHO.every((w) => r[w] && r[w].reply === "accept") ? ["상호 수용"] : []),
        ...(had && WHO.every((w) => r[w] && r[w].stance === "change") ? ["양측 수정"] : []),
        ...(WHO.every((w) => r[w] && !r[w].rebuttal) ? ["남은 차이 없음"] : []),
      ];
      if (signals.length && it.status === "open") it.converge = { round: rnd, signals };
    }
    const acts = WHO.map((w) => `${NAMES[w]} `
      + (r[w] ? STANCE_KO[r[w].stance] + (r[w].reply === "accept" ? "·지적 수용" : "") : "누락")).join(" / ");
    log += `- ${iid}: ${acts} → ${ITEM_KO[it.status]}`
      + (it.status === "stall_candidate" ? ` (${it.stall_reason})` : "")
      + (it.converge ? ` · 수렴 신호: ${it.converge.signals.join(", ")}` : "") + "\n";
  }
  for (const w of WHO) {
    for (const n of res[w].new) {
      const nid = `N${st.next_id.N}`;
      st.next_id.N += 1;
      st.proposals.push({
        id: nid, by: w, round: rnd, text: n.question,
        grounds: n.grounds, impact: n.impact, status: "pending",
      });
      log += `- ${nid} 새 쟁점 제안 (${NAMES[w]}): ${n.question}\n`;
    }
  }
  [st.round, st.note_all] = [rnd, null];
  if (rnd >= st.max_rounds) {
    const moved = deferUnresolved(st, "최대 라운드 도달");
    [st.phase, st.pending_step] = ["final", null];
    log += `\n> 최대 라운드 도달: ${moved.join(", ") || "남은 항목 없음"} 보류 → 최종안 단계\n`;
  } else {
    [st.phase, st.pending_step] = ["discussion", "round"];
  }
  appendLog(d, log);
  const mark = `### 라운드 ${rnd} 처리\n`;
  st.last_summary = log.slice(log.indexOf(mark) + mark.length).trim().split("\n");
  return st;
}

async function jstepFinal(st, d) {
  const v = st.final.version;
  const prompt = Object.fromEntries(WHO.map((w) => [w, header(st, w) + "\n[최종안 검토]\n진행자가 토의 결과로 최종안을 조립했다. "
    + "진행자는 조립만 하고 새 결론을 더하지 않아야 한다.\n"
    + `\n[합의점과 확정된 결론]\n${concludedText(st)}\n\n[전체 쟁점표]\n${tableText(st)}\n`
    + `\n[최종안 v${v}]\n${st.final.draft}\n\n`
    + "다음 네 가지를 확인하라.\n"
    + "- agreements: 합의된 항목이 그대로 반영됐는가\n"
    + "- user_decisions: 사용자 판정이 그대로 반영됐는가\n"
    + "- unresolved_listed: 보류·미확인 항목이 미해결·미확인으로 명시됐는가\n"
    + "- no_new_conclusions: 토의에 없던 결론이 추가되지 않았는가\n"
    + "문제마다 points에 적고 type을 아래 셋 중 하나로 분류하라. "
    + "item에는 관련 항목 ID를 적는다. 문제가 없으면 points를 빈 목록으로 둔다.\n"
    + "- wording(표현): 뜻은 토의 기록과 맞고 문장만 고치면 된다\n"
    + "- assembly(조립): 최종안이 토의 기록과 다르게 옮기거나, 항목을 묶어 뜻을 바꾸거나, 결론을 더했다\n"
    + "- substance(실질): 최종안은 기록대로지만 토의 결론 자체에 문제가 있어 쟁점을 다시 논의해야 한다\n"
    + JSON_TAIL + FINAL_JSON]));

  const make = (who, strict) => (body, data, err = null) => {
    let c, out;
    try {
      c = data?.checks;
      if (!isDict(c) || CHECKS.some((k) => !["ok", "problem"].includes(own(c, k)))) {
        throw new FormatError(`'checks'에 ${CHECKS.join(", ")}가 각각 ok 또는 problem으로 있어야 합니다`);
      }
      const pts = data.points;
      if (!Array.isArray(pts)) throw new FormatError("'points' 목록이 필요합니다");
      out = pts.map((p, i) => {
        if (!isDict(p) || !has(POINT_KO, p.type)) {
          throw new FormatError(`points[${i}]: type은 ${Object.keys(POINT_KO).join(" / ")} 중 하나여야 합니다`);
        }
        return {
          type: p.type, item: optStr(p, "item"),
          problem: needStr(p, "problem", `points[${i}]`), suggestion: optStr(p, "suggestion"),
        };
      });
    } catch (e) {
      if (!(e instanceof FormatError) || strict) throw e;
      return { version: v, body, checks: null, points: [], error: err || e.message };
    }
    return { version: v, body, checks: Object.fromEntries(CHECKS.map((k) => [k, c[k]])), points: out, error: err };
  };

  const res = await jBoth(st, d, `final_v${v}`, prompt, make);
  let log = "";
  for (const w of WHO) {
    const r = res[w];
    log += `\n## 최종안 v${v} 검토 · ${NAMES[w]}\n\n${r.body}\n`;
    if (r.error) {
      log += `\n> 형식 오류 (재시도 후): ${r.error}\n`;
    } else {
      log += "\n" + CHECKS.map((k) => `${k}=${r.checks[k]}`).join(", ") + "\n";
      log += r.points.map((p) => `- [${POINT_KO[p.type]}] ${p.item || "-"}: ${p.problem}`
        + (p.suggestion ? ` → ${p.suggestion}` : "") + "\n").join("");
    }
  }
  appendLog(d, log);
  [st.final.reviews, st.pending_step] = [res, null];
  st.last_summary = [];   // 검토 결과는 printManual의 [최종안] 절에 나온다
  return st;
}

const J_STEPS = { r1: jstepR1, r2: jstepR2, round: jstepRound, final_review: jstepFinal };

function manualBlockers(st) {
  // next를 부를 수 없는 이유 목록 (절차 조건만 본다)
  const step = st.pending_step;
  if (st.status === "halted" || ["r1", "final_review"].includes(step)) return [];
  if (step == null) return ["지금은 실행할 AI 단계가 없습니다"];
  if (step === "r2") return !isEmpty(st.items) ? [] : ["쟁점표 초안을 먼저 edit로 넘겨야 합니다"];
  let out = [];
  for (const [iid, it] of Object.entries(st.items)) {
    if (it.status === "wording_conflict") out.push(`${iid} 표현 충돌: pick-wording으로 골라야 합니다`);
    else if (it.status === "open" && !isEmpty(it.wording_proposals)) out.push(`${iid} 표현 수정안이 반영되지 않았습니다 (edit op revise)`);
  }
  out = out.concat(st.missing_issues.filter((m) => !m.handled).map((m) => `${m.id} 빠진 쟁점 제안이 반영되지 않았습니다 (edit op add)`));
  out = out.concat(Object.entries(st.items).filter(([, it]) => it.converge && it.status === "open")
    .map(([iid, it]) => `${iid} 수렴 신호(${it.converge.signals.join(", ")})를 진행자가 판단해야 합니다 (edit op converge)`));
  if (!openIssues(st).length) out.push("논의 중인 쟁점이 없습니다 (판정·추가 공방(reopen)·최종안 중에서 고르세요)");
  return out;
}

function printManual(d, st) {
  const name = path.basename(d);
  print(`토의: ${name}  (수동 모드 · 라운드 ${st.round}/${st.max_rounds} · ${PHASE_KO[st.phase]} 단계)`);
  if (st.status === "halted") {
    print(`상태: 중단 · ${J_STEP_KO[st.pending_step]} 단계 · 사유: ${st.halt_reason}`);
    print(`재개: node discussion.mjs next ${name} --mode manual`);
  } else if (st.status === "done") {
    print(`상태: 종료 · ${st.result}`);
  } else if (st.pending_step) {
    print(`다음 AI 단계: ${J_STEP_KO[st.pending_step]}`);
  }
  if (st.requirements.length) {
    print("\n[요구사항]");
    for (const r of st.requirements) print(`  ${r.id}: ${r.text}` + (r.round ? ` (R${r.round} 뒤 추가)` : ""));
  }
  if (st.last_summary?.length) print("\n[직전 AI 단계 처리]\n" + st.last_summary.join("\n"));
  print("\n[쟁점표]\n" + tableText(st));
  const ms = st.missing_issues.filter((m) => !m.handled);
  if (ms.length) {
    print("\n[반영 대기 중인 빠진 쟁점 제안]");
    for (const m of ms) print(`  ${m.id} (${NAMES[m.by]}): ${m.question}\n    이유: ${m.reason}`);
  }
  const ps = st.proposals.filter((p) => p.status === "pending");
  if (ps.length) {
    print("\n[새 쟁점 제안 (사용자 승인 대기)]");
    for (const p of ps) {
      print(`  ${p.id} (${whoKo(p.by)}, R${p.round}): ${p.text}\n    근거: ${p.grounds}\n    결론에 미치는 영향: ${p.impact}`);
    }
  }
  const f = st.final;
  if (f.draft) {
    print(`\n[최종안 v${f.version}]`);
    for (const [w, r] of Object.entries(f.reviews)) {
      if (r.error) {
        print(`  ${NAMES[w]} 검토 (v${r.version}): 형식 오류로 결과를 읽지 못함 — ${r.error}`);
        continue;
      }
      const bad = CHECKS.filter((k) => r.checks[k] !== "ok");
      print(`  ${NAMES[w]} 검토 (v${r.version}): ` + (bad.length ? `문제 ${bad.join(", ")}` : "확인 항목 모두 ok"));
      for (const p of r.points) {
        print(`    - [${POINT_KO[p.type]}] ${p.item || "-"}: ${p.problem}` + (p.suggestion ? `\n      제안: ${p.suggestion}` : ""));
      }
    }
  }
  if (st.last_raw?.length) print("\n직전 AI 단계 원문: " + st.last_raw.join(", "));
  print(`전체 기록: ${posix(path.join(d, "log.md"))}`);
  const used = usageLine(d);
  if (used) print(used);
  if (st.status === "done") return;
  const cmds = PHASE_CMDS[st.phase];
  const blockers = cmds.includes("next") ? manualBlockers(st) : [];
  if (blockers.length) process.stdout.write("\nnext 전에 할 일:\n" + blockers.map((b) => `  - ${b}\n`).join(""));
  print("\n쓸 수 있는 명령:");
  for (const c of cmds) {
    if (c === "next" && blockers.length) continue;
    print("  node discussion.mjs " + CMD_USAGE[c].replaceAll("{id}", `${name} --mode manual`));
  }
}

function fakeManual(st, tag, who, attempt) {
  // --dry-run 용 가짜 응답 (수동 모드). scenario로 철회·교착·최대 라운드·표현 충돌·형식 오류·호출 실패를 만든다
  const sc = st.scenario, items = st.items;
  const block = (obj) => `(${NAMES[who]}) ${tag} 본문\n\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;

  if (tag === "r1") return `(${NAMES[who]}) 독립 답변`;
  if (sc === "callfail") throw new Error("가짜 호출 실패");
  if (tag === "r3" && who === "codex" && (sc === "format_halt" || (sc === "format" && attempt === 1))) {
    return '본문\n\n```json\n{"items": [\n```';
  }
  if (tag === "r2") {
    const rows = [];
    let nA = 0, nS = 0;
    for (const [iid, it] of Object.entries(items)) {
      if (it.kind === "issue") {
        if (sc === "wording" && iid === "I1") {
          rows.push({ id: iid, wording: { revise: `${NAMES[who]}가 고친 질문`, reason: "가짜 사유" } });
        } else {
          rows.push({ id: iid, wording: "ok", position: `${NAMES[who]} 입장 (${iid})`, grounds: "가짜 근거", rebuttal: "가짜 반박" });
        }
      } else if (it.kind === "agree_candidate") {
        nA += 1;
        rows.push(nA === 1 ? { id: iid, confirm: true, note: `${NAMES[who]} 가짜 단서` }
          : who === "claude" ? { id: iid, confirm: true }
            : { id: iid, confirm: false, reason: "가짜 이의" });
      } else if (it.owner !== who) {
        const resp = ONE_SIDED[nS % 4];
        rows.push({ id: iid, response: resp, reason: "가짜 사유", ...(resp === "agree" ? { note: "가짜 동의 단서" } : {}) });
        nS += 1;
      }
    }
    const mi = who === "codex" ? [{ question: "가짜 빠진 쟁점", reason: "가짜 사유" }] : [];
    return block({ items: rows, missing_issues: mi });
  }
  if (tag.startsWith("final")) {
    // Claude는 늘 표현 지적, Codex는 v1에 조립 지적·이후엔 실질 지적
    const first = Object.keys(items)[0];
    const pt = who === "claude"
      ? { type: "wording", item: first, problem: "가짜 표현 문제", suggestion: "가짜 제안" }
      : { type: st.final.version === 1 ? "assembly" : "substance", item: first, problem: "가짜 조립·실질 문제" };
    return block({ checks: Object.fromEntries(CHECKS.map((c) => [c, "ok"])), points: [pt] });
  }
  const rnd = st.round + 1, o = OTHER[who], rows = [];
  openIssues(st).forEach((iid, i) => {
    const it = items[iid], r = { id: iid };
    if (it.wording_changed_round === rnd - 1) r.prior_rebuttal_valid = true;
    if (it.last_rebuttal[o]) Object.assign(r, { responds_to: "가짜 요지", reply: sc === "converge" ? "accept" : "counter", grounds: "가짜 근거" });
    if (!has(it.positions, who) || ["maxround", "converge"].includes(sc)) {
      r.stance = "change";
      r.position = `${NAMES[who]} 입장 R${rnd} (${iid})`;
    } else if (sc === "agree" && who === "codex" && i === 0 && has(it.positions, o)) {
      [r.stance, r.note] = ["withdraw", "가짜 철회 단서"];
    } else {
      r.stance = "hold";
      if (i === 0) r.position = `${NAMES[who]} 다듬은 입장 R${rnd} (${iid})`;
    }
    if (r.stance !== "withdraw" && sc !== "converge") r.rebuttal = `${NAMES[who]} 반박 R${rnd}`;   // converge: 남은 차이 없음
    rows.push(r);
  });
  const nw = who === "claude" && rnd === 3 ? [{ question: `가짜 새 쟁점 R${rnd}`, grounds: "가짜 근거", impact: "가짜 영향" }] : [];
  return block({ items: rows, new_issues: nw });
}


// ── 수동 모드: 진행자·사용자 명령 ─────────────────────────────────────
function openJudge(a) {
  const d = discussionDir(a.id);
  const st = load(d);
  if (st.mode !== "manual") die("수동 모드 토의가 아닙니다");
  if (!PHASE_CMDS[st.phase].includes(a.cmd)) {
    const allowed = PHASE_CMDS[st.phase].join(", ") || "없음";
    die(`지금 단계(${PHASE_KO[st.phase]})에서는 ${a.cmd}를 쓸 수 없습니다. 쓸 수 있는 명령: ${allowed}`);
  }
  return [d, st];
}

function getItem(st, iid, statuses = null) {
  const it = own(st.items, iid);
  if (it == null) die(`없는 항목입니다: ${iid}`);
  if (statuses && !statuses.includes(it.status)) {
    die(`${iid}는 ${ITEM_KO[it.status]} 상태라 이 명령을 쓸 수 없습니다 (가능: ${statuses.map((s) => ITEM_KO[s]).join(", ")})`);
  }
  return it;
}

function commit(d, st, log) {
  appendLog(d, log);
  save(d, st);
  printManual(d, st);
}

function resetFinal(st) {
  // 최종안을 만든 뒤 결론이 바뀌면 그 최종안은 다시 등록해야 한다
  if (st.final.draft) {
    [st.final.draft, st.final.reviews] = [null, {}];
    if (st.phase === "final") st.pending_step = null;
    print("결론이 바뀌어 등록된 최종안을 내렸습니다. 최종안을 다시 조립해 final로 넘기세요.\n");
  }
}

function editTable(st, data) {
  if (!isDict(data) || !["issues", "agree_candidates", "one_sided"].some((k) => has(data, k))) {
    throw new FormatError('쟁점표 초안은 {"issues", "agree_candidates", "one_sided"} 객체여야 합니다');
  }
  st.items = {};
  Object.assign(st.next_id, { I: 1, A: 1, S: 1 });
  for (const [key, kind, prefix] of [["issues", "issue", "I"], ["agree_candidates", "agree_candidate", "A"], ["one_sided", "one_sided", "S"]]) {
    const rows = has(data, key) ? data[key] : [];
    if (!Array.isArray(rows)) throw new FormatError(`'${key}'는 목록이어야 합니다`);
    rows.forEach((r, i) => {
      if (!isDict(r)) throw new FormatError(`${key}[${i}]가 객체가 아닙니다`);
      const text = needStr(r, "text", `${key}[${i}]`);
      let owner = null;
      if (kind === "one_sided") {
        owner = r.owner;
        if (!has(NAMES, owner)) throw new FormatError(`${key}[${i}]: owner는 claude 또는 codex여야 합니다`);
      }
      addItem(st, prefix, newItem(kind, text, "moderator", owner));
    });
  }
  if (isEmpty(st.items)) throw new FormatError("쟁점표에 항목이 하나도 없습니다");
}

function editOps(st, ops) {
  const allowed = {
    baseline: ["revise", "add"],
    discussion: ["merge_proposals", "flag_missing", "converge"],
    final: ["converge"],   // 마지막 라운드의 수렴 신호는 보류된 뒤에 판단한다
  }[st.phase];
  ops.forEach((op, i) => {
    const where = `ops[${i}]`;
    if (!isDict(op) || !allowed.includes(op.op)) throw new FormatError(`${where}: 지금 단계에서 쓸 수 있는 op는 ${allowed.join(", ")}입니다`);
    if (op.op === "revise") {
      const it = own(st.items, op.id);
      if (!it || it.status !== "open" || isEmpty(it.wording_proposals)) {
        throw new FormatError(`${where}: 표현 수정안이 있는 논의 중 쟁점에만 쓸 수 있습니다 (${op.id})`);
      }
      if (!has(it.wording_proposals, op.source)) {
        throw new FormatError(`${where}: source에는 수정안을 낸 AI(${Object.keys(it.wording_proposals).join(", ")})를 적어라`);
      }
      [it.text, it.wording_changed_round] = [needStr(op, "text", where), st.round];
      it.wording_proposals = {};
    } else if (op.op === "add") {
      const src = isStr(op.source) ? [op.source] : op.source;
      const ms = Object.fromEntries(st.missing_issues.map((m) => [m.id, m]));
      if (!Array.isArray(src) || !src.length || src.some((s) => !has(ms, s) || ms[s].handled)) {
        throw new FormatError(`${where}: source에는 반영하지 않은 빠진 쟁점 제안 ID(M번호)를 적어라`);
      }
      const text = needStr(op, "text", where);
      const iid = addItem(st, "I", newItem("issue", text, originOf(src.map((s) => ms[s].by))));
      for (const s of src) ms[s].handled = iid;
    } else if (op.op === "merge_proposals") {
      const props = Object.fromEntries(st.proposals.map((p) => [p.id, p]));
      const ids = op.ids;
      if (!Array.isArray(ids) || new Set(ids).size < 2 || ids.some((x) => !has(props, x) || props[x].status !== "pending")) {
        throw new FormatError(`${where}: ids에는 승인 대기 중인 새 쟁점 제안을 두 개 이상 적어라`);
      }
      const sel = [...new Set(ids)].map((x) => props[x]);
      const nid = `N${st.next_id.N}`;
      st.next_id.N += 1;
      st.proposals.push({
        id: nid, by: originOf(sel.map((p) => p.by)), round: st.round,
        text: needStr(op, "text", where),
        grounds: sel.map((p) => `(${p.id}) ${p.grounds}`).join("\n"),
        impact: sel.map((p) => `(${p.id}) ${p.impact}`).join("\n"),
        status: "pending", merged_from: sel.map((p) => p.id),
      });
      for (const p of sel) p.status = `merged:${nid}`;
    } else if (op.op === "converge") {
      // 수렴 신호가 있는 쟁점을 진행자가 판단한다. 결론 문안은 두 입장 문장 안에서만 쓴다
      const it = own(st.items, op.id);
      if (!it || !["open", "deferred"].includes(it.status) || !it.converge) {
        throw new FormatError(`${where}: 수렴 신호가 있는 논의 중·보류 쟁점에만 쓸 수 있습니다 (${op.id})`);
      }
      if (!["agree", "open"].includes(op.decision)) throw new FormatError(`${where}: decision은 agree 또는 open이어야 합니다`);
      const reason = needStr(op, "reason", where);
      if (op.decision === "agree") {
        it.status = "agreed";
        it.resolution = {
          by: "moderator", text: needStr(op, "text", where),
          reason, signals: it.converge.signals, round: st.round,
        };
        it.reason = null;
        resetFinal(st);
      }
      it.converge = null;
    } else {
      const it = own(st.items, op.id);
      if (!it || it.status !== "open") throw new FormatError(`${where}: 논의 중인 쟁점에만 쓸 수 있습니다 (${op.id})`);
      const who = op.who;
      if (!has(NAMES, who)) throw new FormatError(`${where}: who는 claude 또는 codex여야 합니다`);
      const reason = needStr(op, "reason", where);
      it.missing[who] += 1;
      if (it.missing[who] >= 2) stall(it, `${NAMES[who]} 응답 누락 반복 (진행자 표시: ${reason})`);
    }
  });
}

function cmdEdit(a) {
  const [d, st] = openJudge(a);
  const raw = readText(a.file);
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    die(`JSON을 읽을 수 없습니다: ${e.message}`);
  }
  const nw = structuredClone(st);
  try {
    if (st.phase === "draft") {
      if (st.pending_step !== "r2") die("R1이 끝난 뒤에 쟁점표를 넘길 수 있습니다");
      editTable(nw, data);
    } else {
      // op 목록, {"ops": [...]}, op 하나 모두 받는다
      const ops = isDict(data) ? (has(data, "ops") ? data.ops : [data]) : data;
      if (!Array.isArray(ops) || !ops.length) throw new FormatError("op 목록이 필요합니다");
      editOps(nw, ops);
    }
  } catch (e) {
    if (!(e instanceof FormatError)) throw e;
    die(`형식 오류: ${e.message}`);
  }
  commit(d, nw, `\n## 진행자 쟁점표 입력 (${PHASE_KO[st.phase]})\n\n\`\`\`json\n${raw.trim()}\n\`\`\`\n`);
}

function cmdJudge(a) {
  const [d, st] = openJudge(a);
  const it = getItem(st, a.item, ["open", "stall_candidate", "deferred"]);
  if (Boolean(a.who) === Boolean(a.text)) die("claude|codex 또는 --text 중 하나만 적으세요");
  let text;
  if (a.who) {
    if (!has(it.positions, a.who)) die(`${a.item}에 ${NAMES[a.who]}의 입장이 없습니다`);
    text = it.positions[a.who].text;
  } else {
    text = a.text;
  }
  it.status = "user_decided";
  it.resolution = { by: "user", who: a.who, text, round: st.round };
  resetFinal(st);
  commit(d, st, `\n## 사용자 판정 (R${st.round} 뒤)\n\n- ${a.item} → `
    + (a.who ? `${NAMES[a.who]} 쪽` : `사용자 결론: ${a.text}`) + "\n");
}

function cmdJudgeAll(a) {
  const [d, st] = openJudge(a);
  const ids = Object.entries(st.items).filter(([, it]) => ["open", "stall_candidate"].includes(it.status)).map(([iid]) => iid);
  if (!ids.length) die("판정할 미해결 쟁점이 없습니다");
  const lack = ids.filter((iid) => !has(st.items[iid].positions, a.who));
  if (lack.length) die(`${NAMES[a.who]}의 입장이 없는 쟁점이 있습니다: ${lack.join(", ")}`);
  for (const iid of ids) {
    const it = st.items[iid];
    it.status = "user_decided";
    it.resolution = { by: "user", who: a.who, text: it.positions[a.who].text, round: st.round };
  }
  commit(d, st, `\n## 사용자 판정 (R${st.round} 뒤)\n\n- 남은 쟁점 전부(${ids.join(", ")}) → ${NAMES[a.who]} 쪽\n`);
}

function cmdNote(a) {
  const [d, st] = openJudge(a);
  if (a.target === "all") {
    st.note_all = st.note_all ? `${st.note_all}\n${a.text}` : a.text;
  } else {
    const it = getItem(st, a.target, ["open"]);
    it.user_note = it.user_note ? `${it.user_note}\n${a.text}` : a.text;
  }
  commit(d, st, `\n## 사용자 의견 (R${st.round} 뒤)\n\n- ${a.target}: ${a.text}\n`);
}

function cmdReq(a) {
  const [d, st] = openJudge(a);
  const qid = `Q${st.next_id.Q}`;
  st.next_id.Q += 1;
  st.requirements.push({ id: qid, text: a.text, round: st.round });
  commit(d, st, `\n## 요구사항 추가 (R${st.round} 뒤)\n\n- ${qid}: ${a.text}\n`);
}

function cmdDefer(a) {
  const [d, st] = openJudge(a);
  const it = getItem(st, a.item, ["open", "stall_candidate"]);
  [it.status, it.reason] = ["deferred", "사용자 보류"];
  commit(d, st, `\n## 사용자 판정 (R${st.round} 뒤)\n\n- ${a.item} 보류\n`);
}

function cmdExclude(a) {
  const [d, st] = openJudge(a);
  const it = getItem(st, a.item, ["open", "stall_candidate", "deferred", "wording_conflict"]);
  [it.status, it.reason] = ["excluded", a.reason ? `사용자 제외: ${a.reason}` : "사용자 제외"];
  commit(d, st, `\n## 사용자 판정 (R${st.round} 뒤)\n\n- ${a.item} 제외` + (a.reason ? `: ${a.reason}` : "") + "\n");
}

function cmdPickWording(a) {
  const [d, st] = openJudge(a);
  const it = getItem(st, a.item, ["wording_conflict"]);
  it.text = it.wording_proposals[a.who].revise;
  [it.status, it.wording_proposals, it.wording_changed_round] = ["open", {}, st.round];
  commit(d, st, `\n## 사용자 판정\n\n- ${a.item} 표현: ${NAMES[a.who]} 수정안 선택 → ${it.text}\n`);
}

function cmdProposal(a) {
  const [d, st] = openJudge(a);
  const p = st.proposals.find((x) => x.id === a.nid);
  if (p == null || p.status !== "pending") die(`승인 대기 중인 제안이 아닙니다: ${a.nid}`);
  let log;
  if (a.decision === "accept") {
    const iid = addItem(st, "I", newItem("issue", p.text, p.by));
    [p.status, p.item] = ["accepted", iid];
    log = `- ${a.nid} 승인 → 쟁점 ${iid}: ${p.text}\n`;
  } else {
    p.status = "rejected";
    log = `- ${a.nid} 거절: ${p.text}\n`;
  }
  commit(d, st, `\n## 새 쟁점 제안 처리 (R${st.round} 뒤)\n\n${log}`);
}

function cmdReopen(a) {
  const [d, st] = openJudge(a);
  const it = st.phase === "discussion"
    ? getItem(st, a.item, ["stall_candidate", "deferred"])
    : getItem(st, a.item, Object.keys(ITEM_KO).filter((s) => !["open", "wording_conflict"].includes(s)));
  Object.assign(it, {
    kind: "issue", status: "open", stall_reason: null, resolution: null, reason: null,
    keep_streak: { claude: 0, codex: 0 }, missing: { claude: 0, codex: 0 },
  });
  resetFinal(st);
  [st.phase, st.pending_step] = ["discussion", "round"];
  if (st.round >= st.max_rounds) print("최대 라운드를 넘겨 한 라운드 더 진행합니다. 그 라운드가 끝나면 남은 쟁점은 다시 보류됩니다.\n");
  commit(d, st, `\n## 쟁점 재개 (R${st.round} 뒤)\n\n- ${a.item}\n`);
}

async function cmdFinal(a) {
  const [d, st] = openJudge(a);
  const text = readText(a.file).trim();
  if (!text) die("최종안 파일이 비어 있습니다");
  const moved = deferUnresolved(st, "최종안 요청 시 미해결");
  const v = st.final.version + 1;
  st.final = { version: v, draft: text, reviews: {} };
  [st.phase, st.pending_step] = ["final", "final_review"];
  const need = Object.entries(st.items)
    .filter(([iid, it]) => ["agreed", "user_decided", "deferred", "unverified"].includes(it.status)
      && !new RegExp(`(?<![A-Za-z0-9])${iid}(?![0-9])`).test(text))
    .map(([iid]) => iid);
  if (need.length) print(`주의: 최종안에 출처 ID가 없는 항목이 있습니다: ${need.join(", ")}\n`);
  appendLog(d, `\n## 최종안 v${v} (진행자 조립)\n\n` + (moved.length ? `> 미해결 항목 보류 처리: ${moved.join(", ")}\n\n` : "") + text);
  save(d, st);
  await runPending(d, st);
}

function finalSkeleton(st) {
  // 최종안 뼈대. 항목 상태별로 나누고 출처 ID를 붙인다. 진행자는 결론 절과 문장 연결만 채운다
  let s = `# ${st.topic} — 최종안\n\n- 주제: ${st.topic}\n`
    + st.requirements.map((r) => `- 요구사항 ${r.id}: ${r.text}\n`).join("")
    + `- 진행: 라운드 ${st.round}/${st.max_rounds}까지\n\n## 결론\n\n`
    + "<!-- 진행자: 아래 항목에서 ID를 붙여 옮긴다. 새 결론이나 항목을 묶는 분류 소제목을 쓰지 않는다 -->\n";
  const pending = ["deferred", ...UNRESOLVED];
  const groups = [["합의", ["agreed"]], ["사용자 판정", ["user_decided"]],
    ["미해결 (보류)", pending], ["미확인", ["unverified"]], ["제외", ["excluded"]]];
  for (const [title, statuses] of groups) {
    const rows = Object.entries(st.items).filter(([, it]) => statuses.includes(it.status));
    if (!rows.length) continue;
    s += `\n## ${title}\n\n`;
    for (const [iid, it] of rows) {
      const r = it.resolution;
      if (r) {
        s += `- ${r.text} (${iid}, ${howText(r)})\n`;
        if (r.text !== it.text) s += `  - 쟁점: ${it.text}\n`;
      } else {
        s += `- ${iid}. ${it.text}\n`;
        if (pending.includes(it.status)) {
          s += WHO.filter((w) => has(it.positions, w))
            .map((w) => `  - ${NAMES[w]} (R${it.positions[w].round}): ${it.positions[w].text}\n`).join("");
        }
        if (it.reason) s += `  - 사유: ${it.reason}\n`;
      }
      s += notesLines(it, "  - ").map((x) => `${x}\n`).join("");
    }
  }
  return s;
}

function cmdFinalDraft(a) {
  const [d, st] = openJudge(a);
  const p = path.join(d, "final_draft.md");
  writeText(p, finalSkeleton(st));
  print(`최종안 뼈대: ${posix(p)}\n결론 절과 문장 연결을 채운 뒤 final로 등록하세요.`);
}

function cmdFinalFix(a) {
  const [d, st] = openJudge(a);
  const f = st.final;
  if (!f.draft || st.pending_step) die("검토가 끝난 최종안이 있어야 표현 지적을 반영할 수 있습니다");
  const asm = Object.entries(f.reviews).flatMap(([w, r]) =>
    r.points.filter((p) => p.type === "assembly").map((p) => `${NAMES[w]}: ${p.item || "-"}`));
  if (asm.length) die(`조립 지적(${asm.join(", ")})이 있어 final-fix를 쓸 수 없습니다. 고친 최종안을 final로 다시 등록해 재검토하세요`);
  const text = readText(a.file).trim();
  if (!text) die("최종안 파일이 비어 있습니다");
  f.version += 1;
  f.draft = text;
  commit(d, st, `\n## 최종안 v${f.version} (표현 지적 반영, 재검토 없음)\n\n${text}`);
}

function cmdConfirm(a) {
  const [d, st] = openJudge(a);
  if (!st.final.draft || st.pending_step) die("검토가 끝난 최종안이 있어야 확정할 수 있습니다");
  writeText(path.join(d, "final.md"), st.final.draft);
  [st.status, st.phase, st.result] = ["done", "done", `최종 확정 (v${st.final.version})`];
  commit(d, st, `\n## 결과: ${st.result}\n\n- 최종안: final.md\n- 종료: ${clock()}\n`);
}

function cmdEnd(a) {
  const [d, st] = openJudge(a);
  [st.status, st.phase, st.pending_step, st.result] = ["done", "done", null, "판정 없이 종료"];
  commit(d, st, `\n## 결과: 판정 없이 종료\n\n- 종료: ${clock()}\n`);
}

const MODES = { auto: [STEPS, STEP_KO, printStatus], manual: [J_STEPS, J_STEP_KO, printManual] };
const MODE_KO = { auto: "자동 모드", manual: "수동 모드" };
const OLD_MODES = { consensus: "auto", judge: "manual" };
const SPEC_EXAMPLE = `spec 예:
  {"mode": "manual", "name": "짧은이름", "topic": "...", "background": "...",
   "requirements": ["..."], "context": ["참조파일.md"], "workdir": null, "max_rounds": 5}`;

function checkMode(a) {
  // 모드 스킬이 다른 모드의 토의를 이어 가지 않도록 막는다 (last와 지정 id 모두 실제 토의를 찾은 뒤 비교)
  const d = discussionDir(a.id);
  const st = load(d);
  if (st.mode !== a.mode) {
    die(`${path.basename(d)}는 ${MODE_KO[st.mode]} 토의입니다. /ai-discussion:${st.mode} 스킬로 이어 가세요`
      + ` (어느 모드인지 모르면 /ai-discussion:start)`);
  }
}


// ── 명령 ─────────────────────────────────────────────────────────────
async function cmdStart(a) {
  const spec = JSON.parse(readText(a.spec));
  const mode = spec.mode;
  if (!has(MODES, mode)) die(`spec의 mode는 ${Object.keys(MODES).join(" 또는 ")}여야 합니다\n${SPEC_EXAMPLE}`);
  if (a.mode && a.mode !== mode) {
    die(`spec의 mode(${mode})가 --mode ${a.mode}와 다릅니다. /ai-discussion:${a.mode} 스킬이면 spec의 mode를 "${a.mode}"로 쓰세요`);
  }
  const topic = (spec.topic || "").trim();
  if (!topic) die(`spec에 topic이 필요합니다\n${SPEC_EXAMPLE}`);
  if (!a.dry_run) {
    const missing = WHO.filter((w) => !which(w));
    if (missing.length) die(`PATH에서 ${missing.join(", ")} CLI를 찾을 수 없습니다. 설치하고 로그인한 뒤 다시 실행하세요`);
  }
  const via = spec.via ?? null;
  const files = spec.context ?? [];
  const context = files.map((f) => `--- ${f} ---\n${readText(f)}`).join("\n\n");
  let workdir = spec.workdir ?? null;
  if (workdir) {
    workdir = path.resolve(workdir);
    if (!fs.existsSync(workdir) || !fs.statSync(workdir).isDirectory()) die(`폴더가 없습니다: ${workdir}`);
  }

  const author = mode === "auto" ? nextAuthor() : null;
  // 토의 이름은 짧게: spec의 name(없으면 주제 앞 10자)
  const slug = [...(spec.name || topic).trim().replace(/[^\p{L}\p{N}_]+/gu, "_")].slice(0, 10).join("").replace(/^_+|_+$/g, "");
  const now = new Date();
  let d = path.join(DISCUSSIONS, `${stamp(now)}_${slug}`);
  let n = 2;
  while (fs.existsSync(d)) {   // 같은 분에 시작한 토의와 이름이 겹치면 번호를 붙인다
    const base = path.basename(d);
    const cut = base.lastIndexOf("~");
    d = path.join(path.dirname(d), `${cut >= 0 ? base.slice(0, cut) : base}~${n}`);
    n += 1;
  }
  fs.mkdirSync(path.join(d, "raw"), { recursive: true });
  // 토의 기록이 호출한 프로젝트의 git에 섞이지 않게 폴더 전체를 무시시킨다. 사용자가 고친 파일은 덮어쓰지 않는다
  const ignore = path.join(DISCUSSIONS, ".gitignore");
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n");
  const name = path.basename(d);
  const claudeModel = spec.claude_model ?? CLAUDE_MODEL;
  const meta = `- 참가 Claude 모델: ${claudeModel}\n` + (files.length ? `- 참조 파일: ${files.join(", ")}\n` : "")
    + (workdir ? `- 작업 폴더: ${workdir}\n` : "")
    + (a.dry_run ? "- dry-run: " + a.scenario + "\n" : "");
  let st;
  if (mode === "manual") {
    const reqs = spec.requirements ?? [];
    st = {
      id: name, mode: "manual", via, topic, background: spec.background ?? "",
      requirements: reqs.map((t, i) => ({ id: `Q${i + 1}`, text: t, round: 0 })),
      context_files: files, context, workdir, claude_model: claudeModel,
      max_rounds: Math.max(3, Math.trunc(Number(spec.max_rounds ?? 5))),   // R1, R2 포함
      dry_run: a.dry_run, scenario: a.scenario,
      status: "running", pending_step: "r1", halt_reason: null,
      phase: "draft", round: 0, r1: {}, items: {},
      next_id: { I: 1, A: 1, S: 1, N: 1, M: 1, Q: reqs.length + 1 },
      missing_issues: [], proposals: [], note_all: null,
      final: { version: 0, draft: null, reviews: {} }, result: null,
    };
    save(d, st);
    appendLog(d, `# ${topic}\n\n- 모드: 수동 모드\n- 시작: ${clock(now)}\n` + meta);
  } else {
    st = {
      id: name, mode: "auto", via, topic,
      background: spec.background ?? "", requirements: spec.requirements ?? [],
      context_files: files, context, workdir, claude_model: claudeModel,
      max_rounds: Math.max(2, Math.trunc(Number(spec.max_rounds ?? 5))),
      author, dry_run: a.dry_run, scenario: a.scenario,
      status: "running", pending_step: "r1", halt_reason: null,
      round: 0, r1: {}, criteria: {}, draft: "", draft_version: 0,
      points: {}, next_point: 1, result: null, fail_reason: "",
      clean_final: spec.clean_final ?? true,   // 합의 뒤 토의 경과 표현을 뺀 정리본을 만든다
    };
    save(d, st);
    appendLog(d, `# ${topic}\n\n- 모드: 자동 모드\n- 시작: ${clock(now)}\n`
      + `- 작성자: ${NAMES[author]} / 검토자: ${NAMES[OTHER[author]]}\n` + meta);
  }
  await runPending(d, st);
}

async function cmdNext(a) {
  const d = discussionDir(a.id);
  const st = load(d);
  const showFn = MODES[st.mode][2];
  if (st.status === "done") {
    print("이미 끝난 토의입니다.\n");
    showFn(d, st);
    return;
  }
  if (st.mode === "manual") {
    const blockers = manualBlockers(st);
    if (blockers.length) die("next를 실행할 수 없습니다:\n" + blockers.map((b) => `  - ${b}\n`).join(""));
  }
  if (a.scenario) {
    if (!st.dry_run) die("--scenario는 dry-run 토의에서만 쓸 수 있습니다");
    st.scenario = a.scenario;
  }
  await runPending(d, st);
}

async function cmdRun(a) {
  // 자동 모드 토의를 종료나 중단까지 이어서 실행한다. 중단된 토의는 그 단계부터 다시 실행한다
  const d = discussionDir(a.id);
  let st = load(d);
  if (st.mode !== "auto") die("run은 자동 모드 토의에서만 쓸 수 있습니다. 수동 모드 토의는 next로 진행하세요");
  while (st.status !== "done") {
    const step = st.pending_step;
    st = await runPending(d, st, false);
    const left = unresolved(st);
    print(`- ${STEP_KO[step]} ${st.status === "halted" ? "중단" : "끝"} · 라운드 ${st.round}/${st.max_rounds} · 남은 지적 ${left.length ? left.join(", ") : "없음"}`);
    if (st.status === "halted") break;
  }
  print();
  printStatus(d, st);
  if (st.status === "halted") process.exitCode = 1;
}

function cmdShow(a) {
  const d = discussionDir(a.id);
  const st = load(d);
  MODES[st.mode][2](d, st);
}


// ── 명령줄 해석 ──────────────────────────────────────────────────────
const ID = { name: "id" };
const ITEM = { name: "item" };
const WHO_ARG = { name: "who", choices: WHO };
const FILE_OPT = (help) => ({ file: { required: true, help } });
const COMMANDS = {
  start: {
    help: "토의를 만들고 R1을 실행", fn: cmdStart, args: [],
    opts: {
      spec: { required: true, help: "주제·배경·요구사항 등을 담은 JSON 파일" },
      "dry-run": { flag: true, help: "CLI 호출 없이 가짜 응답으로 시험" },
      scenario: { choices: SCENARIOS, default: "agree", help: "dry-run 시나리오" },
    },
  },
  next: { help: "다음 단계 실행 (중단된 단계는 다시 실행)", fn: cmdNext, args: [ID], opts: { scenario: { choices: SCENARIOS, help: "dry-run 시나리오 변경" } } },
  run: { help: "자동 모드 토의를 끝날 때까지 실행 (중단되면 종료 코드 1)", fn: cmdRun, args: [ID] },
  show: { help: "현재 상태 출력", fn: cmdShow, args: [ID] },
  // 수동 모드 전용 명령 (docs/manual-mode-flow.md "하위 명령")
  edit: { help: "쟁점표 작성·수정 (진행자)", fn: cmdEdit, args: [ID], opts: FILE_OPT("쟁점표 초안 또는 op 목록 JSON") },
  judge: { help: "쟁점 판정", fn: cmdJudge, args: [ID, ITEM, { ...WHO_ARG, optional: true }], opts: { text: { help: "사용자 결론" } } },
  "judge-all": { help: "미해결 쟁점 전체를 한쪽으로 판정", fn: cmdJudgeAll, args: [ID, WHO_ARG] },
  note: { help: "다음 라운드에 붙일 사용자 의견", fn: cmdNote, args: [ID, { name: "target", help: "항목 ID 또는 all" }, { name: "text" }] },
  req: { help: "요구사항 추가", fn: cmdReq, args: [ID, { name: "text" }] },
  defer: { help: "쟁점 보류", fn: cmdDefer, args: [ID, ITEM] },
  exclude: { help: "쟁점 제외 (최종안에 넣지 않음)", fn: cmdExclude, args: [ID, ITEM, { name: "reason", optional: true, help: "사유 (로그에 남김)" }] },
  "pick-wording": { help: "표현 충돌 해결", fn: cmdPickWording, args: [ID, ITEM, WHO_ARG] },
  proposal: { help: "새 쟁점 제안 승인·거절", fn: cmdProposal, args: [ID, { name: "nid" }, { name: "decision", choices: ["accept", "reject"] }] },
  reopen: { help: "교착·보류 쟁점 추가 공방, 또는 최종안 실질 지적 쟁점 재개", fn: cmdReopen, args: [ID, ITEM] },
  "final-draft": { help: "최종안 뼈대 만들기 (항목 상태별, 출처 ID 포함)", fn: cmdFinalDraft, args: [ID] },
  final: { help: "최종안 등록 후 두 AI 검토", fn: cmdFinal, args: [ID], opts: FILE_OPT("최종안 Markdown 파일") },
  "final-fix": { help: "최종안 표현 지적 반영 (재검토 없음)", fn: cmdFinalFix, args: [ID], opts: FILE_OPT("최종안 Markdown 파일") },
  confirm: { help: "최종 확정", fn: cmdConfirm, args: [ID] },
  end: { help: "판정 없이 종료", fn: cmdEnd, args: [ID] },
};
// 토의를 여는 모든 명령과 start에 --mode를 둔다 (start는 spec의 mode와 비교)
for (const c of Object.values(COMMANDS)) {
  if (c.args.includes(ID) || c.fn === cmdStart) c.opts = { ...c.opts, mode: { choices: Object.keys(MODES), help: "토의 mode가 다르면 거부" } };
}

function usage(cmd, c) {
  const pos = c.args.map((x) => (x.optional ? `[${x.name}]` : x.name));
  const opts = Object.entries(c.opts ?? {}).map(([k, o]) => {
    const s = o.flag ? `--${k}` : `--${k} ${k.toUpperCase()}`;
    return o.required ? s : `[${s}]`;
  });
  return `usage: discussion.mjs ${cmd} [-h] ${[...opts, ...pos].join(" ")}`.trimEnd();
}

function printHelp(cmd) {
  if (!cmd) {
    print(`usage: discussion.mjs [-h] {${Object.keys(COMMANDS).join(",")}} ...\n\nClaude × Codex 토의\n\npositional arguments:`);
    for (const [k, c] of Object.entries(COMMANDS)) print(`  ${k.padEnd(20)}${c.help}`);
    print("\noptions:\n  -h, --help          show this help message and exit");
    return;
  }
  const c = COMMANDS[cmd];
  print(usage(cmd, c) + `\n\n${c.help}`);
  if (c.args.length) {
    print("\npositional arguments:");
    for (const x of c.args) print(`  ${x.name.padEnd(20)}${x.help ?? (x.choices ? x.choices.join(" | ") : "")}`);
  }
  print("\noptions:\n  -h, --help          show this help message and exit");
  for (const [k, o] of Object.entries(c.opts ?? {})) {
    print(`  ${(o.flag ? `--${k}` : `--${k} ${k.toUpperCase()}`).padEnd(20)}${o.help ?? ""}` + (o.choices ? ` (${o.choices.join(", ")})` : ""));
  }
}

function parseArgs(argv) {
  const fail = (cmd, msg) => {
    throw new Exit((cmd ? usage(cmd, COMMANDS[cmd]) : "usage: discussion.mjs [-h] <명령> ...") + `\ndiscussion.mjs: error: ${msg}`, 2);
  };
  const [cmd, ...rest] = argv;
  if (cmd === "-h" || cmd === "--help") return printHelp(null);
  if (cmd == null) fail(null, "명령이 필요합니다");
  if (!has(COMMANDS, cmd)) fail(null, `알 수 없는 명령입니다: '${cmd}' (가능: ${Object.keys(COMMANDS).join(", ")})`);
  const c = COMMANDS[cmd], opts = c.opts ?? {};
  const a = { cmd, fn: c.fn };
  for (const [k, o] of Object.entries(opts)) a[k.replaceAll("-", "_")] = o.flag ? false : (o.default ?? null);
  const pos = [];
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === "--") {
      pos.push(...rest.slice(i + 1));
      break;
    }
    if (tok === "-h" || tok === "--help") return printHelp(cmd);
    if (!tok.startsWith("--")) {
      pos.push(tok);
      continue;
    }
    const [k, inline] = tok.slice(2).split(/=(.*)/s);
    if (!has(opts, k)) fail(cmd, `알 수 없는 인자입니다: ${tok}`);
    const o = opts[k], dest = k.replaceAll("-", "_");
    if (o.flag) {
      a[dest] = true;
      continue;
    }
    const v = inline ?? rest[++i];
    if (v == null) fail(cmd, `--${k}에 값이 필요합니다`);
    if (o.choices && !o.choices.includes(v)) fail(cmd, `--${k}: '${v}'는 쓸 수 없습니다 (가능: ${o.choices.join(", ")})`);
    a[dest] = v;
  }
  const need = c.args.filter((x) => !x.optional).length;
  if (pos.length < need) fail(cmd, `필요한 인자가 없습니다: ${c.args.slice(pos.length).filter((x) => !x.optional).map((x) => x.name).join(", ")}`);
  if (pos.length > c.args.length) fail(cmd, `알 수 없는 인자입니다: ${pos.slice(c.args.length).join(" ")}`);
  c.args.forEach((x, i) => {
    const v = pos[i] ?? null;
    if (v != null && x.choices && !x.choices.includes(v)) fail(cmd, `${x.name}: '${v}'는 쓸 수 없습니다 (가능: ${x.choices.join(", ")})`);
    a[x.name] = v;
  });
  for (const [k, o] of Object.entries(opts)) {
    if (o.required && a[k.replaceAll("-", "_")] == null) fail(cmd, `다음 인자가 필요합니다: --${k}`);
  }
  return a;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a) return;
  if (a.mode && a.fn !== cmdStart) checkMode(a);
  await a.fn(a);
}

main().catch((e) => {
  if (!(e instanceof Exit)) throw e;
  process.stderr.write(e.message + "\n");
  process.exitCode = e.code;
});
