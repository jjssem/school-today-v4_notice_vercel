// 공지: 선생님의 구글 스프레드시트(첫 번째 시트)를 읽어 화면에 띠로 보여 줍니다.
//   A열 = 공지 내용, B열 = 시작일(선택), C열 = 종료일(선택)
//   날짜를 비우면 계속 표시 / 시작일만 있으면 그날부터 / 종료일만 있으면 그날까지
// 우리 서버에는 아무것도 저장하지 않고, 시트 주인이 '링크가 있는 모든 사용자(뷰어)'로 공유했거나 '웹에 게시'한 시트만 읽을 수 있습니다.

export const MAX_TEXT = 80;      // 공지 한 건의 최대 글자 수 (넘으면 … 로 줄임)
export const MAX_ROWS = 20;      // 시트에서 읽는 최대 공지 수
const ID_RE = /^[A-Za-z0-9_-]{25,150}$/;
const HEADERS = new Set(["공지", "내용", "공지내용", "공지사항", "알림"]);

export const validId = id => ID_RE.test(id || "");

// 시트 ID → CSV 주소. '웹에 게시' ID(2PACX-…)와 보통 시트 ID 둘 다 받음. 구글 주소로만 요청함
export function sheetCsvUrl(id) {
  return id.startsWith("2PACX-")
    ? `https://docs.google.com/spreadsheets/d/e/${id}/pub?output=csv`
    : `https://docs.google.com/spreadsheets/d/${id}/export?format=csv`;
}

// CSV 읽기 (따옴표·칸 안의 쉼표와 줄바꿈 처리)
export function parseCsv(text) {
  const rows = []; let row = [], cell = "", q = false;
  const s = String(text || "").replace(/^﻿/, "");
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
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// "2026-11-12", "2026. 11. 12", "11/12", "11월 12일" → "20261112" (읽지 못하면 null, 비어 있으면 "")
export function parseDate(v, year) {
  const t = String(v || "").trim();
  if (!t) return "";
  const n = (t.match(/\d+/g) || []).map(Number);
  let y, m, d;
  if (n.length >= 3 && n[0] > 31) [y, m, d] = n;
  else if (n.length >= 3 && n[2] > 31) [m, d, y] = n;          // 11/12/2026
  else if (n.length === 2) { y = year; [m, d] = n; }
  else return null;
  if (y < 100) y += 2000;
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  return String(y) + String(m).padStart(2, "0") + String(d).padStart(2, "0");
}

export function toNotices(csvText, year) {
  const out = [];
  for (const r of parseCsv(csvText)) {
    let text = String(r[0] || "").replace(/\s+/g, " ").trim();
    if (!text || HEADERS.has(text.replace(/\s/g, ""))) continue;   // 빈 줄·제목 줄은 건너뜀
    const from = parseDate(r[1], year), to = parseDate(r[2], year);
    if (from === null || to === null) continue;                    // 날짜를 읽지 못한 줄은 잘못 띄우지 않도록 뺌
    if ([...text].length > MAX_TEXT) text = [...text].slice(0, MAX_TEXT - 1).join("") + "…";
    out.push({ text, from, to });
    if (out.length >= MAX_ROWS) break;
  }
  return out;
}

export async function fetchNotices(id, year) {
  const res = await fetch(sheetCsvUrl(id), { redirect: "follow" });
  const type = res.headers.get("content-type") || "";
  const host = (() => { try { return new URL(res.url).hostname; } catch (e) { return ""; } })();
  if (res.status === 404) throw new Error("시트를 찾지 못했어요. 주소(ID)를 확인해 주세요.");
  if (!res.ok || host === "accounts.google.com" || !/csv|text\/plain/i.test(type)) {
    throw new Error("시트를 읽을 수 없어요. 공유 설정을 '링크가 있는 모든 사용자 · 뷰어'로 바꿔 주세요.");
  }
  return toNotices(await res.text(), year);
}
