// 공지: /api/notice?id=구글시트ID
// 선생님의 구글 스프레드시트를 읽어 공지 목록을 돌려줍니다. (인증키 필요 없음, 서버에 저장하지 않음)
import { validId, fetchNotices } from "../lib/notice-core.js";

async function handler(req) {
  const id = new URL(req.url).searchParams.get("id") || "";
  if (!validId(id)) return Response.json({ error: "시트 ID가 올바르지 않아요." }, { status: 400 });
  try {
    const year = new Date(Date.now() + 9 * 3600e3).getUTCFullYear();   // 한국 시간 기준 올해 ('11/12'처럼 연도 없는 날짜용)
    const notices = await fetchNotices(id, year);
    return Response.json({ notices }, {
      headers: { "Cache-Control": "public, max-age=120", "Vercel-CDN-Cache-Control": "max-age=300" },   // 최대 5분
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}

// Vercel: /api/notice 로 들어오는 GET 요청
export async function GET(request) {
  return handler(request);
}
