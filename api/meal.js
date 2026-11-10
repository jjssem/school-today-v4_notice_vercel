// 급식 (나이스): 학교 이름 + 주소로 전국에서 나이스 학교코드를 찾아 조회
//   /api/meal?name=물메초등학교&addr=제주특별자치도 제주시 애월읍 엄수로 202-4&from=YYYYMMDD&to=YYYYMMDD
// 인증키: 환경변수 NEIS_API_KEY

const API = "https://open.neis.go.kr/hub/";
const codeCache = new Map();   // "이름|주소" → {office, code, neisName}

async function neis(service, params) {
  const q = new URLSearchParams({ Type: "json", pIndex: "1", pSize: "100", ...params });
  if (process.env.NEIS_API_KEY) q.set("KEY", process.env.NEIS_API_KEY);
  const res = await fetch(API + service + "?" + q);
  if (!res.ok) throw new Error("나이스 서버 응답 오류 (" + res.status + ")");
  const json = await res.json();
  if (json.RESULT) {
    if (json.RESULT.CODE === "INFO-200") return [];
    throw new Error(json.RESULT.MESSAGE);
  }
  return json[service][1].row;
}

const norm = s => (s || "").replace(/\s+/g, "");
const tokens = s => (s || "").split(/\s+/).filter(Boolean);

// 같은 이름 학교가 여러 곳이면(예: 금성초등학교 11곳) 주소가 가장 비슷한 곳을 고름
function pickByAddress(rows, addr) {
  if (rows.length === 1) return rows[0];
  const want = tokens(addr);
  let best = rows[0], bestScore = -1;
  for (const r of rows) {
    const have = norm(r.ORG_RDNMA) + "|" + norm(r.ORG_RDNDA);
    if (addr && norm(r.ORG_RDNMA) === norm(addr)) return r;
    const score = want.reduce((n, t) => n + (have.includes(t) ? t.length : 0), 0);
    if (score > bestScore) { best = r; bestScore = score; }
  }
  return best;
}

async function findSchool(name, addr) {
  const key = name + "|" + addr;
  if (codeCache.has(key)) return codeCache.get(key);
  // 교육청을 지정하지 않고 전국에서 이름으로 찾음 (교육청 통합·개편에도 영향 없음)
  let rows = await neis("schoolInfo", { SCHUL_NM: name });
  const exact = rows.filter(r => norm(r.SCHUL_NM) === norm(name));
  if (exact.length) rows = exact;
  if (!rows.length) throw new Error("나이스에서 이 학교를 찾지 못했어요: " + name);
  const r = pickByAddress(rows, addr);
  const hit = { office: r.ATPT_OFCDC_SC_CODE, code: r.SD_SCHUL_CODE, neisName: r.SCHUL_NM };
  codeCache.set(key, hit);
  return hit;
}

const isYmd = s => /^\d{8}$/.test(s || "");

async function handler(req) {
  const p = new URL(req.url).searchParams;
  const name = (p.get("name") || "").trim();
  const addr = (p.get("addr") || "").trim();
  const from = p.get("from"), to = p.get("to");
  if (!name || !isYmd(from) || !isYmd(to)) {
    return Response.json({ error: "name, from, to 값이 필요합니다." }, { status: 400 });
  }
  try {
    const s = await findSchool(name, addr);
    const rows = await neis("mealServiceDietInfo", {
      ATPT_OFCDC_SC_CODE: s.office, SD_SCHUL_CODE: s.code,
      MMEAL_SC_CODE: "2", MLSV_FROM_YMD: from, MLSV_TO_YMD: to,
    });
    const meals = rows
      .map(r => ({ date: r.MLSV_YMD, dishes: r.DDISH_NM, kcal: r.CAL_INFO }))
      .sort((a, b) => a.date.localeCompare(b.date));
    return Response.json({ meals, school: s }, { headers: {
      "Cache-Control": "public, max-age=600",
      // Vercel CDN에 30분 저장 → 같은 학교 학급들이 나눠 씀 (나이스 호출 최소화)
      "Vercel-CDN-Cache-Control": "max-age=1800, stale-while-revalidate=3600",
    } });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 502 });
  }
};

// Vercel: /api/meal 로 들어오는 GET 요청
export async function GET(request) {
  return handler(request);
}
