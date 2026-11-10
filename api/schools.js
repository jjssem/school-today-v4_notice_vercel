// 학교 찾기: 위치(GPS·와이파이) / 접속 IP / 이름 검색 / ID 조회
//   /api/schools?lat=..&lon=..      → 가까운 학교
//   /api/schools                    → 접속 IP 기준 대략적인 위치에서 가까운 학교
//   /api/schools?q=물메              → 이름 검색
//   /api/schools?id=B000008005e     → 학교 한 곳
//   공통: &level=e|m|h (초·중·고 필터)

import data from "../generated/schools.json" with { type: "json" };

const LEVEL_NAME = { e: "초등학교", m: "중학교", h: "고등학교" };
const schools = data.schools.map(([id, name, level, lat, lon, addr]) => ({ id, name, level, lat, lon, addr }));
const byId = new Map(schools.map(s => [s.id, s]));
const norm = s => s.replace(/\s+/g, "").toLowerCase();
const keyOf = new Map(schools.map(s => [s.id, norm(s.name)]));

function distKm(aLat, aLon, bLat, bLon) {
  const R = 6371, D = Math.PI / 180;
  const dLat = (bLat - aLat) * D, dLon = (bLon - aLon) * D;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * D) * Math.cos(bLat * D) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

const view = (s, origin) => ({
  ...s,
  levelName: LEVEL_NAME[s.level] || "",
  dist: origin ? Math.round(distKm(origin.lat, origin.lon, s.lat, s.lon) * 100) / 100 : undefined,
});

const meta = { baseDate: data.meta.baseDate, count: data.meta.count, file: data.meta.file };

async function handler(req) {
  const url = new URL(req.url);
  const p = url.searchParams;
  const level = p.get("level");
  const pool = level && LEVEL_NAME[level] ? schools.filter(s => s.level === level) : schools;
  const headers = { "Cache-Control": "public, max-age=3600", "Vercel-CDN-Cache-Control": "max-age=86400" };

  // 1) 학교 한 곳
  if (p.get("id")) {
    const s = byId.get(p.get("id"));
    if (!s) return Response.json({ error: "학교를 찾지 못했어요. 학교 자료가 바뀌었을 수 있어요.", meta }, { status: 404 });
    return Response.json({ school: view(s), meta }, { headers });
  }

  // 2) 이름 검색 (위치가 있으면 가까운 순으로 정렬)
  const q = norm(p.get("q") || "");
  if (q) {
    const lat = Number(p.get("lat")), lon = Number(p.get("lon"));
    const origin = lat && lon ? { lat, lon } : null;
    const hits = pool.filter(s => keyOf.get(s.id).includes(q)).map(s => view(s, origin));
    hits.sort((a, b) => {
      const as = keyOf.get(a.id).startsWith(q) ? 0 : 1, bs = keyOf.get(b.id).startsWith(q) ? 0 : 1;
      if (as !== bs) return as - bs;
      if (origin) return a.dist - b.dist;
      return a.name.localeCompare(b.name, "ko");
    });
    return Response.json({ source: "search", total: hits.length, schools: hits.slice(0, 30), meta }, { headers });
  }

  // 3) 위치 기준 가까운 학교
  let origin = null, source = "gps";
  const lat = Number(p.get("lat")), lon = Number(p.get("lon"));
  if (lat && lon) origin = { lat, lon };
  else {
    // Vercel이 접속 IP로 추정한 위치 (요청 헤더로 전달됨)
    const h = req.headers;
    const glat = Number(h.get("x-vercel-ip-latitude")), glon = Number(h.get("x-vercel-ip-longitude"));
    if (glat && glon) {
      const dec = v => { try { return decodeURIComponent(v || ""); } catch { return v || ""; } };
      origin = { lat: glat, lon: glon, city: dec(h.get("x-vercel-ip-city")), region: dec(h.get("x-vercel-ip-country-region")) };
      source = "ip";
    }
  }
  if (!origin) return Response.json({ source: "none", schools: [], meta });

  const near = pool
    .map(s => ({ s, d: distKm(origin.lat, origin.lon, s.lat, s.lon) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, Math.min(Number(p.get("limit")) || 12, 30))
    .map(({ s }) => view(s, origin));
  return Response.json({ source, origin, schools: near, meta },
    { headers: source === "ip"
      ? { "Cache-Control": "private, no-store" }                       // 사람마다 IP 위치가 다르므로 저장 안 함
      : { "Cache-Control": "public, max-age=3600", "Vercel-CDN-Cache-Control": "max-age=86400" } });
};

// Vercel: /api/schools 로 들어오는 GET 요청
export async function GET(request) {
  return handler(request);
}
