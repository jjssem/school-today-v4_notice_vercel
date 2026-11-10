// 기상특보: 기상청_기상특보 조회서비스(getPwnStatus = 현재 특보 발효 현황)를 읽고
// 학교 주소에 해당하는 '학교 생활 관련' 특보만 골라냅니다.
// weather.mjs(화면 반영)와 warnings.mjs(확인용 원본 보기)가 함께 씁니다.

// ── 반영할 특보 (넣고 빼려면 여기만 고치면 됨) ─────────────────────
// 제외: 풍랑(바다), 건조(산불), 폭풍해일(해안 저지대)
export const RELEVANT = ["강풍", "호우", "대설", "태풍", "폭염", "한파", "황사"];
// ────────────────────────────────────────────────────────────────

const URL_STATUS = "https://apis.data.go.kr/1360000/WthrWrnInfoService/getPwnStatus";

// 공공데이터포털 응답 읽기 (키 오류는 XML로 옴)
async function getItems(url) {
  const res = await fetch(url);
  const text = await res.text();
  if (text.trim().startsWith("<")) {
    const msg = (text.match(/<returnAuthMsg>(.*?)<\/returnAuthMsg>/) || text.match(/<resultMsg>(.*?)<\/resultMsg>/) || [])[1];
    throw new Error(msg === "SERVICE_KEY_IS_NOT_REGISTERED_ERROR"
      ? "인증키가 등록되지 않았거나 기상특보 서비스 활용신청이 안 되어 있어요" : (msg || "응답 형식 오류"));
  }
  const json = JSON.parse(text);
  const code = json?.response?.header?.resultCode;
  if (code && code !== "00") {
    if (code === "03") return [];            // NO_DATA = 발효 중인 특보 없음
    throw new Error(json.response.header.resultMsg);
  }
  const items = json?.response?.body?.items;
  return Array.isArray(items) ? items : (items?.item ? [].concat(items.item) : []);
}

// 현재 특보 현황 원본 (전국 공통 자료 → 5분 동안 함수 메모리에 두고 여러 학교가 나눠 씀)
let statusCache = null, statusAt = 0;
const STATUS_TTL = 5 * 60 * 1000;
export async function fetchStatus() {
  if (statusCache && Date.now() - statusAt < STATUS_TTL) return statusCache.item;
  const item = await fetchStatusFresh();
  statusCache = { item }; statusAt = Date.now();
  return item;
}
async function fetchStatusFresh() {
  const q = new URLSearchParams({
    serviceKey: process.env.DATA_GO_KR_KEY || "", pageNo: "1", numOfRows: "10", dataType: "JSON",
  });
  const items = await getItems(URL_STATUS + "?" + q);
  // 가장 최근 발표분
  items.sort((a, b) => String(b.tmFc || "").localeCompare(String(a.tmFc || "")));
  return items[0] || null;
}

// "o 강풍주의보 : 제주도(제주도북부, 제주도서부), 울릉도.독도" → [{kind, level, name, area}]
export function parseStatus(t6) {
  const out = [];
  if (!t6) return out;
  for (const line of String(t6).split(/\r?\n/)) {
    const m = line.match(/^\s*[oO○●ㅇ·\-]?\s*([가-힣]+?)(주의보|경보)\s*:\s*(.+)$/);
    if (!m) continue;
    out.push({ kind: m[1], level: m[2], name: m[1] + m[2], area: m[3].trim() });
  }
  return out;
}

// ── 지역 매칭 ────────────────────────────────────────────────────
// 특보 구역 표기의 시·도 이름
const SIDO = [
  ["서울", ["서울"]], ["부산", ["부산"]], ["대구", ["대구"]], ["인천", ["인천"]], ["광주", ["광주"]],
  ["대전", ["대전"]], ["울산", ["울산"]], ["세종", ["세종"]], ["경기", ["경기도"]], ["강원", ["강원도"]],
  ["충청북", ["충청북도"]], ["충북", ["충청북도"]], ["충청남", ["충청남도"]], ["충남", ["충청남도"]],
  ["전북", ["전북자치도", "전라북도", "전북"]], ["전라북", ["전라북도", "전북자치도"]],
  ["전라남", ["전라남도"]], ["전남광주", ["전남광주", "광주", "전라남도"]],
  ["경상북", ["경상북도"]], ["경상남", ["경상남도"]], ["제주", ["제주도"]],
];

// 제주는 시·군이 아니라 북부·남부·동부·서부·산지·추자도로 나뉨.
// 경계에 걸친 읍·면은 양쪽 구역을 모두 해당으로 봄 (놓치는 것보다 한 번 더 알리는 쪽).
const JEJU = [
  [/추자면/, ["추자도"]],
  [/우도면|구좌읍|성산읍|표선면/, ["제주도동부"]],
  [/한림읍|한경면|대정읍|안덕면/, ["제주도서부"]],
  [/애월읍/, ["제주도북부", "제주도서부"]],
  [/조천읍/, ["제주도북부", "제주도동부"]],
  [/남원읍/, ["제주도남부", "제주도동부"]],
];
// 읍·면이 아닌 동 지역
const JEJU_CITY = [[/제주시/, ["제주도북부"]], [/서귀포시/, ["제주도남부"]]];

// 시·군 이름의 핵심 글자: "강릉시"→"강릉", "가평군"→"가평"
const stem = w => (w || "").replace(/(특별시|광역시|특별자치시|특별자치도|시|군|구)$/, "");

// area 문자열에서 시·도 블록 나누기: "경기도(가평, 고양), 서울, 강원도(강릉평지)" → [{head, subs[]}]
function splitArea(area) {
  const blocks = []; let depth = 0, cur = "";
  for (const c of area) {
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) { blocks.push(cur); cur = ""; } else cur += c;
  }
  if (cur.trim()) blocks.push(cur);
  return blocks.map(b => {
    const m = b.trim().match(/^([^(]+?)\s*(?:\((.*)\))?$/);
    return { head: (m?.[1] || b).trim(), subs: m?.[2] ? m[2].split(/[,·]/).map(s => s.trim()).filter(Boolean) : [] };
  });
}

// 학교 주소가 이 특보 구역에 들어가는지
export function matchesAddress(area, addr) {
  const words = (addr || "").split(/\s+/);
  const sidoWord = words[0] || "", sggWord = words[1] || "";
  const heads = new Set(SIDO.filter(([k]) => sidoWord.includes(k)).flatMap(([, v]) => v));
  if (!heads.size) return false;
  const isJeju = sidoWord.startsWith("제주");
  let jejuZones = isJeju ? [...new Set(JEJU.filter(([re]) => re.test(addr)).flatMap(([, z]) => z))] : [];
  if (isJeju && !jejuZones.length) jejuZones = JEJU_CITY.filter(([re]) => re.test(addr)).flatMap(([, z]) => z);
  const sgg = stem(sggWord);

  for (const { head, subs } of splitArea(area)) {
    if (isJeju && (jejuZones.includes(head) || subs.length === 0 && head !== "제주도" && head.startsWith("제주도"))) {
      if (jejuZones.includes(head)) return true; else continue;   // "제주도북부"처럼 구역만 단독으로 적힌 경우
    }
    if (![...heads].some(h => head.startsWith(h) || h.startsWith(head))) continue;
    if (!subs.length) return true;                      // "서울", "부산"처럼 시·도 전체
    if (isJeju) { if (subs.some(s => jejuZones.includes(s))) return true; continue; }
    // "강릉평지", "강원북부산지", "서울동남권" 같은 구역 → 시·군 이름이 들어 있으면 해당
    if (sgg && subs.some(s => s.includes(sgg))) return true;
    // 서울·부산처럼 구 단위로 나뉜 대도시는 시 전체를 해당으로 봄
    if (/특별시|광역시/.test(sidoWord)) return true;
  }
  return false;
}

// 학교 주소에 해당하는 학교 생활 관련 특보
export async function warningsFor(addr) {
  const item = await fetchStatus();
  const all = parseStatus(item?.t6);
  const active = all
    .filter(w => RELEVANT.includes(w.kind))
    .filter(w => matchesAddress(w.area, addr))
    .map(({ kind, level, name }) => ({ kind, level, name }));
  return { tmFc: item?.tmFc || null, active, all, raw: item };
}
