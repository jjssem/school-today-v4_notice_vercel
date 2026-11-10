// 날씨(기상청) + 미세먼지(에어코리아)를 대신 호출하는 Vercel Function
//   /api/weather?lat=33.47&lon=126.39&sido=제주특별자치도
// 인증키: Vercel 환경변수 DATA_GO_KR_KEY (공공데이터포털 '일반 인증키(Decoding)')
// 공공데이터포털에서 아래 두 서비스를 각각 '활용신청' 해야 같은 키로 둘 다 쓸 수 있습니다.
//   - 기상청_단기예보 ((구)_동네예보) 조회서비스
//   - 한국환경공단_에어코리아_대기오염정보   (실시간 측정값 + 대기질 예보통보)
//   - 한국환경공단_에어코리아_측정소정보   (가장 가까운 측정소 찾기)

// 등교~하교 시간 (비·강수확률 판단 기준). 기상청 예보는 1시간 단위라
// 07:30~16:30 이 걸쳐 있는 7시~16시 예보를 봅니다.
import { warningsFor } from "../lib/warnings-core.js";

const SCHOOL_TIME = { start: "07:30", end: "16:30" };
const SCHOOL_HOURS = [Number(SCHOOL_TIME.start.slice(0, 2)), Number(SCHOOL_TIME.end.slice(0, 2))];

const KMA = "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/";
const AIR_BASE = "https://apis.data.go.kr/B552584/";

// 위경도 → 기상청 격자(nx, ny) 변환 (기상청 공식 LCC 변환식)
function toGrid(lat, lon) {
  const RE = 6371.00877, GRID = 5.0, SLAT1 = 30, SLAT2 = 60, OLON = 126, OLAT = 38, XO = 43, YO = 136;
  const D = Math.PI / 180, re = RE / GRID;
  const s1 = SLAT1 * D, s2 = SLAT2 * D, olon = OLON * D, olat = OLAT * D;
  let sn = Math.tan(Math.PI * 0.25 + s2 * 0.5) / Math.tan(Math.PI * 0.25 + s1 * 0.5);
  sn = Math.log(Math.cos(s1) / Math.cos(s2)) / Math.log(sn);
  let sf = Math.tan(Math.PI * 0.25 + s1 * 0.5);
  sf = Math.pow(sf, sn) * Math.cos(s1) / sn;
  let ro = Math.tan(Math.PI * 0.25 + olat * 0.5);
  ro = re * sf / Math.pow(ro, sn);
  let ra = Math.tan(Math.PI * 0.25 + lat * D * 0.5);
  ra = re * sf / Math.pow(ra, sn);
  let theta = lon * D - olon;
  if (theta > Math.PI) theta -= 2 * Math.PI;
  if (theta < -Math.PI) theta += 2 * Math.PI;
  theta *= sn;
  return { nx: Math.floor(ra * Math.sin(theta) + XO + 0.5), ny: Math.floor(ro - ra * Math.cos(theta) + YO + 0.5) };
}

// Vercel 서버는 UTC 시간이므로 한국 시간(KST)으로 계산
function kstParts(ms = Date.now()) {
  const d = new Date(ms + 9 * 3600e3);
  const p = n => String(n).padStart(2, "0");
  return { ymd: d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()), h: d.getUTCHours(), m: d.getUTCMinutes() };
}

async function getJson(url) {
  const res = await fetch(url);
  const text = await res.text();
  if (text.trim().startsWith("<")) {        // 공공데이터포털은 키 오류 등을 XML로 돌려줌
    const msg = (text.match(/<returnAuthMsg>(.*?)<\/returnAuthMsg>/) || text.match(/<resultMsg>(.*?)<\/resultMsg>/) || [])[1];
    throw new Error(msg === "SERVICE_KEY_IS_NOT_REGISTERED_ERROR" ? "인증키가 등록되지 않았거나 활용신청이 안 되어 있어요" : (msg || "응답 형식 오류"));
  }
  const json = JSON.parse(text);
  const code = json?.response?.header?.resultCode;
  if (code && code !== "00") {
    if (code === "03") return [];            // NO_DATA
    throw new Error(json.response.header.resultMsg);
  }
  const items = json?.response?.body?.items;
  return Array.isArray(items) ? items : (items?.item || []);
}

function kmaUrl(op, base_date, base_time, grid, rows) {
  const q = new URLSearchParams({
    serviceKey: process.env.DATA_GO_KR_KEY || "", pageNo: "1", numOfRows: String(rows),
    dataType: "JSON", base_date, base_time, nx: String(grid.nx), ny: String(grid.ny),
  });
  return KMA + op + "?" + q;
}

// 초단기실황: 지금 기온·습도·강수
async function getNow(grid) {
  let t = kstParts();
  if (t.m < 15) t = kstParts(Date.now() - 3600e3);   // 매시 정각 자료는 10분쯤 뒤에 올라옴
  const items = await getJson(kmaUrl("getUltraSrtNcst", t.ymd, String(t.h).padStart(2, "0") + "00", grid, 20));
  const v = Object.fromEntries(items.map(i => [i.category, i.obsrValue]));
  return {
    time: `${t.h}시`,
    temp: v.T1H != null ? Number(v.T1H) : null,
    humidity: v.REH != null ? Number(v.REH) : null,
    rain1h: v.RN1 != null ? Number(v.RN1) : 0,
    pty: v.PTY != null ? Number(v.PTY) : 0,
    wind: v.WSD != null ? Number(v.WSD) : null,
  };
}

// 단기예보: 오늘·내일 최저/최고, 등하교 시간 강수확률·비 오는 시간·하늘
async function getForecast(grid) {
  const now = kstParts();
  const tomorrowYmd = kstParts(Date.now() + 86400e3).ymd;
  // 전날 23시 발표분: 오늘 0시부터의 예보(새벽 포함)와 오늘·내일 최저/최고가 모두 들어 있음
  const items = await getJson(kmaUrl("getVilageFcst", kstParts(Date.now() - 86400e3).ymd, "2300", grid, 1000));

  // 최신 발표분으로 덮어쓰기 (02,05,08,11,14,17,20,23시 발표, 10분쯤 뒤 공개)
  const bases = [2, 5, 8, 11, 14, 17, 20, 23].filter(h => h < now.h || (h === now.h && now.m >= 15));
  if (bases.length) {
    try {
      const latest = await getJson(kmaUrl("getVilageFcst", now.ymd, String(bases.at(-1)).padStart(2, "0") + "00", grid, 1000));
      items.push(...latest);   // 뒤에 오는 값이 우선
    } catch (e) { /* 최신분 실패 시 02시 자료만 사용 */ }
  }

  const num = v => (v == null || v === "") ? null : Number(String(v).replace(/[^\d.-]/g, ""));

  // fromHour: 오늘은 이미 지난 시간은 빼고 '지금부터 하교까지'만 봄
  // 하교 시간이 지난 뒤(저녁·밤)에도 의미 있는 값을 보이도록: 지금부터 자정까지의 최대 강수확률
  function withLater(sum) {
    if (!sum) return sum;
    const byHour = {};
    for (const i of items) if (i.fcstDate === now.ymd && i.category === "POP") byHour[+i.fcstTime.slice(0, 2)] = num(i.fcstValue);
    const later = Object.entries(byHour).filter(([h]) => +h >= now.h).map(([, v]) => v || 0);
    sum.popLater = later.length ? Math.max(...later) : null;
    return sum;
  }

  // fromHour: 학교 기준(등하교 시간) 계산 시작 시각 / pureFrom: 순수 날씨 계산 시작 시각 (오늘=지금, 내일=0시)
  function summarize(ymd, fromHour, pureFrom = 0) {
    const day = items.filter(i => i.fcstDate === ymd);
    if (!day.length) return null;
    const byHour = {};
    for (const i of day) (byHour[+i.fcstTime.slice(0, 2)] ||= {})[i.category] = i.fcstValue;
    const tmn = num(day.filter(i => i.category === "TMN").at(-1)?.fcstValue);
    const tmx = num(day.filter(i => i.category === "TMX").at(-1)?.fcstValue);
    const temps = Object.values(byHour).map(h => num(h.TMP)).filter(v => v != null);
    const school = Object.entries(byHour).filter(([h]) => +h >= fromHour && +h <= SCHOOL_HOURS[1]);
    const popMax = Math.max(0, ...school.map(([, v]) => num(v.POP) || 0));
    const rainHours = school.filter(([, v]) => num(v.PTY) > 0).map(([h, v]) => ({ hour: +h, pty: num(v.PTY) }));
    const mid = byHour[12] || byHour[13] || byHour[11] || {};
    const rainy = rainHours.find(r => r) || null;
    // ── 순수 날씨 (학교 시간과 무관) ──
    const ahead = Object.entries(byHour).filter(([h]) => +h >= pureFrom).sort((a, b) => a[0] - b[0]);
    const popNow = ahead.length ? (num(ahead[0][1].POP) ?? null) : null;            // 지금 시각(가장 가까운 예보 시각)의 강수확률
    const popDay = ahead.length ? Math.max(0, ...ahead.map(([, v]) => num(v.POP) || 0)) : null;   // 하루(남은 시간) 최고 강수확률
    const firstRain = ahead.find(([, v]) => num(v.PTY) > 0);
    // 새벽 비: 0시부터 등교 시간(7시) 전까지 비/눈 예보 → 운동장이 젖어 있을 수 있음
    const dawnRain = Object.entries(byHour).some(([h, v]) => +h < SCHOOL_HOURS[0] && num(v.PTY) > 0);
    return {
      tmn: tmn ?? (temps.length ? Math.min(...temps) : null),
      tmx: tmx ?? (temps.length ? Math.max(...temps) : null),
      sky: num(mid.SKY),                  // 1 맑음, 3 구름많음, 4 흐림
      pty: rainy ? rainy.pty : 0,         // 등하교 시간 중 비/눈 (0 없음, 1 비, 2 비/눈, 3 눈, 4 소나기)
      popMax,
      rainHours,
      rainFrom: rainy ? rainy.hour : null,
      dawnRain,
      window: `${SCHOOL_TIME.start}~${SCHOOL_TIME.end}`,
      // 순수 날씨
      popNow, popDay,
      rainFromDay: firstRain ? +firstRain[0] : null,
      ptyDay: firstRain ? num(firstRain[1].PTY) : 0,
    };
  }

  return {
    today: withLater(summarize(now.ymd, Math.max(SCHOOL_HOURS[0], now.h), now.h)),
    tomorrow: summarize(tomorrowYmd, SCHOOL_HOURS[0], 0),
  };
}

// ── 에어코리아 ───────────────────────────────────────────────
const okVal = v => v != null && v !== "-" && v !== "" && !isNaN(Number(v));
const gradeOf = (v, cuts) => v == null ? 0 : v <= cuts[0] ? 1 : v <= cuts[1] ? 2 : v <= cuts[2] ? 3 : 4;
function airResult(item, station, distKm) {
  const pm10 = okVal(item.pm10Value) ? Number(item.pm10Value) : null;
  const pm25 = okVal(item.pm25Value) ? Number(item.pm25Value) : null;
  return {
    station, distKm: distKm != null ? Math.round(distKm * 10) / 10 : null, time: item.dataTime,
    pm10, pm25,
    grade10: gradeOf(pm10, [30, 80, 150]),   // 환경부 기준
    grade25: gradeOf(pm25, [15, 35, 75]),
  };
}
function airUrl(path, params) {
  const q = new URLSearchParams({ serviceKey: process.env.DATA_GO_KR_KEY || "", returnType: "json", pageNo: "1", ...params });
  return AIR_BASE + path + "?" + q;
}
function distKm(aLat, aLon, bLat, bLon) {
  const R = 6371, D = Math.PI / 180;
  const x = Math.sin((bLat - aLat) * D / 2) ** 2 + Math.cos(aLat * D) * Math.cos(bLat * D) * Math.sin((bLon - aLon) * D / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// 전국 측정소 목록 (하루 동안 기억)
let stationCache = null, stationAt = 0;
async function getStations() {
  if (stationCache && Date.now() - stationAt < 24 * 3600e3) return stationCache;
  const items = await getJson(airUrl("MsrstnInfoInqireSvc/getMsrstnList", { numOfRows: "1000" }));
  const list = items.map(i => {
    const a = Number(i.dmX), b = Number(i.dmY);
    // dmX/dmY 중 위도(33~39)인 값을 위도로 사용
    const [lat, lon] = (a > 30 && a < 40) ? [a, b] : [b, a];
    return { name: i.stationName, lat, lon };
  }).filter(s => s.lat && s.lon);
  if (!list.length) throw new Error("측정소 목록이 비어 있어요");
  stationCache = list; stationAt = Date.now();
  return list;
}

// 1순위: 가장 가까운 측정소 (값이 비어 있으면 다음으로 가까운 곳)
async function getAirNearest(lat, lon) {
  const near = (await getStations())
    .map(s => ({ ...s, d: distKm(lat, lon, s.lat, s.lon) }))
    .sort((a, b) => a.d - b.d).slice(0, 3);
  for (const s of near) {
    const items = await getJson(airUrl("ArpltnInforInqireSvc/getMsrstnAcctoRltmMesureDnsty",
      { numOfRows: "3", stationName: s.name, dataTerm: "DAILY", ver: "1.0" }));
    const item = items.find(i => okVal(i.pm10Value) || okVal(i.pm25Value));
    if (item) return airResult(item, s.name, s.d);
  }
  throw new Error("가까운 측정소에 측정값이 없어요");
}

// 2순위(측정소정보 서비스를 못 쓸 때): 시·도 전체 측정소 중 주소가 겹치는 곳
const SIDO = [["서울","서울"],["부산","부산"],["대구","대구"],["인천","인천"],["광주","광주"],["대전","대전"],
  ["울산","울산"],["세종","세종"],["경기","경기"],["강원","강원"],["충청북","충북"],["충북","충북"],["충청남","충남"],
  ["충남","충남"],["전북","전북"],["전라북","전북"],["전라남","전남"],["전남","전남"],["경상북","경북"],["경북","경북"],
  ["경상남","경남"],["경남","경남"],["제주","제주"]];
// 주소 맨 앞 낱말(시·도)만 보고 판단 — '경기도 광주시'를 광주로 잘못 읽지 않도록
// '전남광주통합특별시'는 광주·전남 자료가 따로라, 광주의 5개 구면 광주 먼저 · 나머지 시·군은 전남 먼저
const GWANGJU_GU = ["동구", "서구", "남구", "북구", "광산구"];
const sidoNames = addr => {
  const [head = "", second = ""] = (addr || "").trim().split(/\s+/);
  const names = [...new Set(SIDO.filter(([k]) => head.includes(k)).map(([, v]) => v))];
  if (names.includes("광주") && names.includes("전남")) return GWANGJU_GU.includes(second) ? ["광주", "전남"] : ["전남", "광주"];
  return names;
};
async function getAirBySido(sidoText, addrHint) {
  const names = sidoNames(sidoText);
  if (!names.length) throw new Error("시·도를 알 수 없어요");
  const words = (addrHint || "").split(/\s+/).map(w => w.replace(/(시|군|구|읍|면|동)$/, "")).filter(w => w.length >= 2);
  for (const sidoName of names) {
    const items = await getJson(airUrl("ArpltnInforInqireSvc/getCtprvnRltmMesureDnsty",
      { numOfRows: "200", sidoName, ver: "1.0" }));
    const valid = items.filter(i => okVal(i.pm10Value));
    const pick = valid.find(i => words.some(w => i.stationName.includes(w))) || valid[0];
    if (pick) return airResult(pick, pick.stationName, null);
  }
  throw new Error("측정값이 없어요");
}

async function getAir(lat, lon, sido) {
  try { return await getAirNearest(lat, lon); }
  catch (e) {
    if (!sido) throw e;
    return await getAirBySido(sido, sido);
  }
}

// ── 에어코리아 대기질 예보 (내일 미세먼지) ───────────────────
// '대기질 예보통보 조회': 하루 4번(5·11·17·23시) 발표, 전국 19개 권역의 등급(좋음·보통·나쁨·매우나쁨).
// 측정소 값이 아니라 권역 단위 등급이고, 전국 공통 자료라 30분 동안 기억해 둠.
const DUST_GRADE = { "좋음": 1, "보통": 2, "나쁨": 3, "매우나쁨": 4 };
// 경기·강원은 예보 권역이 둘로 나뉨 (아래 시·군 목록에 없으면 경기남부·영서)
// ※ 권역별 시·군 목록은 공개 문서로 확인하지 못해 일반적인 구분을 따름 (김포·태백은 경계 지역)
const GG_NORTH = ["가평", "고양", "구리", "김포", "남양주", "동두천", "양주", "연천", "의정부", "파주", "포천"];
const GW_EAST = ["강릉", "동해", "속초", "삼척", "태백", "고성", "양양"];
function dustRegions(addr) {
  const second = (addr || "").trim().split(/\s+/)[1] || "";
  const names = sidoNames(addr);
  if (names.includes("경기")) return [GG_NORTH.some(c => second.startsWith(c)) ? "경기북부" : "경기남부", "경기"];
  if (names.includes("강원")) return [GW_EAST.some(c => second.startsWith(c)) ? "영동" : "영서", "강원"];
  return names;
}
// "서울 : 보통,제주 : 좋음,…" → 이 학교 권역의 등급 (권역 이름이 조금 달라도 찾도록 포함 여부로 비교)
function gradeIn(informGrade, regions) {
  const rows = String(informGrade || "").split(",").map(x => x.split(":").map(v => v.replace(/\s/g, "")));
  for (const r of regions) {
    const hit = rows.find(([name, g]) => name && name.includes(r) && DUST_GRADE[g]);
    if (hit) return { region: hit[0], grade: DUST_GRADE[hit[1]] };
  }
  return null;
}
const dashDate = ymd => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
let dustCache = {};                                   // 발표일 → { at, items }
async function getDustItems(searchDate) {
  const c = dustCache[searchDate];
  if (c && Date.now() - c.at < 30 * 60e3) return c.items;
  const items = await getJson(airUrl("ArpltnInforInqireSvc/getMinuDustFrcstDspth", { numOfRows: "100", searchDate }));
  dustCache = { ...Object.fromEntries(Object.entries(dustCache).slice(-1)), [searchDate]: { at: Date.now(), items } };
  return items;
}
// 내일(targetYmd) 예보: 오늘 발표분에서 찾고, 새벽 5시 전처럼 아직 없으면 어제 발표분(모레 예보)에서 찾음
async function getDustTomorrow(addr) {
  const regions = dustRegions(addr);
  if (!regions.length) throw new Error("시·도를 알 수 없어요");
  const target = dashDate(kstParts(Date.now() + 86400e3).ymd);
  const stampOf = t => { const m = String(t || "").match(/(\d{4}-\d{2}-\d{2})\D+(\d{1,2})시/); return m ? m[1] + " " + m[2].padStart(2, "0") : ""; };
  for (const day of [kstParts().ymd, kstParts(Date.now() - 86400e3).ymd]) {
    const items = (await getDustItems(dashDate(day))).filter(i => i.informData === target);
    const out = {};
    for (const code of ["PM10", "PM25"]) {
      const latest = items.filter(i => i.informCode === code).sort((a, b) => stampOf(a.dataTime).localeCompare(stampOf(b.dataTime))).at(-1);
      const g = latest && gradeIn(latest.informGrade, regions);
      if (g) { out[code] = g.grade; out.region = g.region; out.time = latest.dataTime; (out.raw ||= {})[code] = latest.informGrade; }
    }
    if (out.PM10 || out.PM25) {
      const pm10 = out.PM10 || 0, pm25 = out.PM25 || 0;
      return { pm10, pm25, worst: Math.max(pm10, pm25), kind: pm25 > pm10 ? "pm25" : "pm10", region: out.region, time: out.time, raw: out.raw };
    }
  }
  return null;                                        // 아직 내일 예보가 없음
}

// 운동장 활동 판단
// 내일 운동장 판단 (하교 뒤 저녁·밤에 화면이 쓰는 값): 내일 등하교 시간(7:30~16:30) 예보 기준
// 미세먼지는 대기질 예보 등급이 '나쁨' 이상이면 주의 (예보는 권역 단위라 실내 권장까지는 올리지 않음)
function judgeTomorrow(t, dust) {
  if (!t) return null;
  const reasons = [];
  let level = "ok";
  const up = l => { if (l === "no" || level === "ok") level = l; };
  if (dust?.worst >= 3) {
    up("caution");
    reasons.push(`${dust.kind === "pm25" ? "초미세먼지" : "미세먼지"} ${dust.worst === 4 ? "매우나쁨" : "나쁨"} 예보`);
  }
  if (t.rainHours?.length) { up("caution"); reasons.push(`${t.rainHours[0].hour}시쯤${t.rainHours[0].pty === 3 ? " 눈" : " 비"} 예보`); }
  else if (t.popMax >= 60) { up("caution"); reasons.push(`강수확률 ${t.popMax}%`); }
  if (t.dawnRain) { up("caution"); reasons.push("새벽 비 — 운동장이 젖어 있을 수 있어요"); }
  if (t.tmx != null && t.tmx >= 33) { up("no"); reasons.push(`폭염 (최고 ${t.tmx}℃)`); }
  else if (t.tmx != null && t.tmx >= 31) { up("caution"); reasons.push(`더위 (최고 ${t.tmx}℃)`); }
  if (t.tmn != null && t.tmn <= -5) { up("caution"); reasons.push(`추위 (최저 ${t.tmn}℃)`); }
  return { level, reasons, umbrella: (t.rainHours?.length > 0) || t.popMax >= 60 };
}

function judge(now, today, air, warnings) {
  const reasons = [];
  let level = "ok";                         // ok / caution / no
  // 기상특보 (학교 생활 관련만): 경보 → 실내 권장, 주의보 → 주의
  for (const w of warnings || []) {
    if (w.level === "경보") level = "no";
    else if (level === "ok") level = "caution";
    reasons.push(w.name);
  }
  const worst = Math.max(air?.grade10 || 0, air?.grade25 || 0);
  if (worst >= 3) { level = "no"; reasons.push(worst === 4 ? "미세먼지 매우나쁨" : "미세먼지 나쁨"); }
  if (now?.pty > 0 || now?.rain1h > 0) {
    level = "no";
    // 강수 형태: 1 비, 2 비/눈, 3 눈, 5 빗방울, 6 빗방울·눈날림, 7 눈날림
    reasons.push([3, 7].includes(now?.pty) ? "지금 눈" : [2, 6].includes(now?.pty) ? "지금 비·눈" : "지금 비");
  }
  else if (today?.rainHours?.length) { if (level === "ok") level = "caution"; reasons.push(`${today.rainHours[0].hour}시쯤 비 예보`); }
  else if (today?.popMax >= 60) { if (level === "ok") level = "caution"; reasons.push(`강수확률 ${today.popMax}%`); }
  if (today?.dawnRain && !(now?.pty > 0)) {
    if (level === "ok") level = "caution";
    reasons.push("새벽에 비 — 운동장이 젖어 있을 수 있어요");
  }
  const hi = today?.tmx ?? now?.temp;
  if (hi != null && hi >= 33) { level = "no"; reasons.push(`폭염 (최고 ${hi}℃)`); }
  else if (hi != null && hi >= 31) { if (level === "ok") level = "caution"; reasons.push(`더위 (최고 ${hi}℃)`); }
  if (now?.temp != null && now.temp <= -5) { if (level === "ok") level = "caution"; reasons.push(`추위 (${now.temp}℃)`); }
  if (now?.wind != null && now.wind >= 9) { if (level === "ok") level = "caution"; reasons.push(`강풍 (${now.wind}m/s)`); }
  const umbrella = (now?.pty > 0) || (today?.rainHours?.length > 0) || (today?.popMax >= 60)
    || (warnings || []).some(w => w.kind === "호우" || w.kind === "태풍");
  return { level, reasons, umbrella };
}

// 지금부터 다음 '매시 15분'까지 남은 초 (최소 60초)
function secondsUntilNextQuarterPast() {
  const now = new Date();
  const next = new Date(now); next.setUTCMinutes(15, 0, 0);
  if (next <= now) next.setUTCHours(next.getUTCHours() + 1);
  return Math.max(60, Math.round((next - now) / 1000));
}

async function handler(req) {
  if (!process.env.DATA_GO_KR_KEY) {
    return Response.json({ error: "Vercel 환경변수 DATA_GO_KR_KEY 가 설정되지 않았어요." }, { status: 500 });
  }
  const p = new URL(req.url).searchParams;
  const lat = Number(p.get("lat")), lon = Number(p.get("lon"));
  const sido = p.get("sido") || "";
  if (!(lat > 32 && lat < 39.5 && lon > 124 && lon < 132)) {
    return Response.json({ error: "lat, lon 값이 필요해요 (국내 좌표)." }, { status: 400 });
  }
  const grid = toGrid(lat, lon);
  const [n, t, a, wr, df] = await Promise.allSettled([getNow(grid), getForecast(grid), getAir(lat, lon, sido), warningsFor(sido), getDustTomorrow(sido)]);
  const now = n.status === "fulfilled" ? n.value : null;
  const today = t.status === "fulfilled" ? t.value.today : null;
  const tomorrow = t.status === "fulfilled" ? t.value.tomorrow : null;
  const air = a.status === "fulfilled" ? a.value : null;
  const dustTomorrow = df.status === "fulfilled" ? df.value : null;   // 내일 미세먼지 예보 (없거나 실패해도 나머지는 그대로)
  // 특보는 실패해도 나머지 화면은 그대로 (errors.warnings 에만 기록)
  const warnings = wr.status === "fulfilled" ? wr.value.active : null;
  const warnTime = wr.status === "fulfilled" ? wr.value.tmFc : null;
  const errors = {};
  if (!warnings) errors.warnings = wr.reason?.message;
  if (!now) errors.now = n.reason?.message;
  if (!today) errors.today = t.reason?.message;
  if (!air) errors.air = a.reason?.message;
  if (df.status !== "fulfilled") errors.dustForecast = df.reason?.message;
  if (!now && !today && !air && !warnings) {
    return Response.json({ error: Object.values(errors)[0] || "날씨 정보를 불러오지 못했어요", errors, grid }, { status: 502 });
  }
  return Response.json(
    { now, today, tomorrow, air, dustTomorrow, warnings: warnings || [], warnTime,
      outdoor: judge(now, today, air, warnings),
      outdoorBase: judge(now, today, air, []),       // 화면이 최신 특보를 따로 받아 덧씌울 때 쓰는 기준값
      outdoorTomorrow: judgeTomorrow(tomorrow, dustTomorrow),     // 16:30 이후 화면은 이 값(내일 기준)으로 신호등 표시
      errors, grid },
    { headers: {
      "Cache-Control": "public, max-age=300",
      // Vercel CDN 저장: 다음 '매시 15분'까지만 (정각 관측값이 10분쯤 뒤 공개되므로, 화면의 매시 20분 갱신이 항상 새 값을 받음)
      "Vercel-CDN-Cache-Control": `max-age=${secondsUntilNextQuarterPast()}`,
    } }
  );
};

// Vercel: /api/weather 로 들어오는 GET 요청
export async function GET(request) {
  return handler(request);
}
