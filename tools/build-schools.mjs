// 「전국초중등학교위치표준데이터」 CSV → generated/schools.json 변환
// Vercel이 배포할 때마다 자동으로 실행합니다 (vercel.json 의 buildCommand).
// 학교 자료를 새로 받으면 data/schools.csv 파일만 바꿔서 GitHub에 올리면 됩니다.

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(root, "data");
const csvName = readdirSync(dataDir).filter(f => f.toLowerCase().endsWith(".csv")).sort().at(-1);
if (!csvName) throw new Error("data 폴더에 CSV 파일이 없습니다.");

// 공공데이터 CSV는 보통 EUC-KR(CP949). UTF-8이면 그대로 읽음.
const buf = readFileSync(join(dataDir, csvName));
let text;
try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); }
catch { text = new TextDecoder("euc-kr").decode(buf); }
text = text.replace(/^﻿/, "");

// 따옴표를 지원하는 간단한 CSV 파서
function parseCsv(s) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.length > 1);
}

const [head, ...body] = parseCsv(text);
const col = name => {
  const i = head.findIndex(h => h.trim() === name);
  if (i < 0) throw new Error(`CSV에 '${name}' 열이 없습니다. 열 목록: ${head.join(", ")}`);
  return i;
};
const C = {
  id: col("학교ID"), name: col("학교명"), level: col("학교급구분"), state: col("운영상태"),
  road: col("소재지도로명주소"), jibun: col("소재지지번주소"),
  lat: col("위도"), lon: col("경도"), base: col("데이터기준일자"),
};
const LEVEL = { "초등학교": "e", "중학교": "m", "고등학교": "h" };

const seen = new Set();
const schools = [];
let baseDate = "";
for (const r of body) {
  if (r[C.state] && r[C.state] !== "운영") continue;
  const lat = Number(r[C.lat]), lon = Number(r[C.lon]);
  if (!lat || !lon) continue;
  const id = r[C.id].trim();
  const key = id + "|" + r[C.level];
  if (seen.has(key)) continue;            // 같은 행 중복 제거
  seen.add(key);
  if (r[C.base] > baseDate) baseDate = r[C.base];
  schools.push([
    id + (LEVEL[r[C.level]] || "x"),       // 고유 ID (같은 ID에 초·중·고가 함께 있는 학교 대비)
    r[C.name].trim(),
    LEVEL[r[C.level]] || "x",
    Math.round(lat * 1e5) / 1e5,
    Math.round(lon * 1e5) / 1e5,
    (r[C.road] || r[C.jibun] || "").trim(),
  ]);
}

const out = {
  meta: { baseDate, file: csvName, count: schools.length, builtAt: new Date().toISOString() },
  fields: ["id", "name", "level", "lat", "lon", "addr"],
  schools,
};
mkdirSync(join(root, "generated"), { recursive: true });
writeFileSync(join(root, "generated", "schools.json"), JSON.stringify(out));
console.log(`학교 ${schools.length}곳 변환 완료 (데이터기준일자 ${baseDate}, ${csvName})`);
