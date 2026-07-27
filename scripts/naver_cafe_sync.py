"""
BEBOLD BORAMAE · 네이버 카페 출석체크 자동 수집 스크립트 (스켈레톤, v2)
=========================================================================
역할: 네이버 카페의 "오늘의 출석체크" 게시글 댓글을 긁어와서 파싱한 뒤,
      Supabase의 reservations 테이블을 오늘 날짜 기준으로 통째로
      재동기화(delete + insert)합니다.

v2 변경사항
- fetch_all_comments가 댓글 텍스트뿐 아니라 작성 시각(commented_at)도 함께 반환
  → 화면에서 "예약 작성 순서"로 정렬하는 데 사용
- "드랍인 2명"처럼 쓴 줄은 드랍인1, 드랍인2 ... 로 자동 확장해서 각각 등록
- *변경* 댓글로 시간을 옮긴 회원은 changed=true로 표시(화면에서 "비고: 시간 변경")

이 파일은 실제로 바로 돌아가는 완성품이 아니라 "골격"입니다.
네이버 카페 쪽 스크래핑 부분(fetch_article_id / fetch_all_comments)은
카페마다 구조가 다르고, 네이버 내부 API가 문서화되어 있지 않아 실제
요청 URL·파라미터·쿠키는 브라우저 개발자도구(Network 탭)로 직접 확인해서
채워 넣어야 합니다. 아래 TODO 표시를 참고하세요.

필요 패키지: pip install requests beautifulsoup4 supabase python-dotenv
쿠키 자동갱신을 쓰려면: pip install playwright  (+ naver_login_setup.py 최초 1회 실행)
실행 주기: cron / Windows 작업 스케줄러로 5분마다 실행
=========================================================================
"""

import os
import re
from datetime import date, datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from supabase import create_client

# scripts/.env가 있으면 여기서 환경변수로 로드됨 (GitHub Actions처럼 이미 환경변수가
# 세팅되어 있는 경우엔 .env가 없어도 그대로 동작 — 기존 값을 덮어쓰지 않음)
load_dotenv()

KST = timezone(timedelta(hours=9))

# -------------------------------------------------------------------------
# 설정값 (환경변수 또는 .env 로 관리 권장)
# -------------------------------------------------------------------------
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_ROLE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]  # 절대 프론트엔드에 노출 금지

NAVER_CLUB_ID = os.environ.get("NAVER_CLUB_ID", "")   # 카페 고유 club id (숫자)
NAVER_MENU_ID = os.environ.get("NAVER_MENU_ID", "")   # 출석체크 게시판 menu id

# 이 카페는 회원만 볼 수 있는 게시판이므로(확인 완료) 로그인 세션이 반드시 필요합니다.
# naver_login_setup.py를 먼저 한 번 실행해 이 폴더에 로그인 세션을 저장해두면,
# 아래 get_session()이 매번 여기서 최신 쿠키를 자동으로 꺼내 씁니다.
# (naver_login_setup.py의 NAVER_PROFILE_DIR과 반드시 같은 경로여야 합니다.)
NAVER_PROFILE_DIR = Path.home() / ".bebold_naver_profile"

# 위 방식을 아직 안 쓰고 그냥 값만 손으로 넣고 싶다면 여기 채워도 됩니다.
# (NAVER_PROFILE_DIR이 존재하면 이 값보다 우선 사용됩니다.)
NAVER_COOKIES_FALLBACK = {
    # "NID_AUT": "...",
    # "NID_SES": "...",
}

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)


def _cookies_from_profile() -> Optional[dict]:
    """저장된 Playwright 프로필에서 헤드리스로 최신 쿠키를 읽어옴 (수동 복사 불필요)."""
    if not NAVER_PROFILE_DIR.exists():
        return None
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            user_data_dir=str(NAVER_PROFILE_DIR), headless=True
        )
        cookies = {c["name"]: c["value"] for c in context.cookies() if c["name"] in ("NID_AUT", "NID_SES")}
        context.close()
    return cookies or None


def _cookies_from_env() -> Optional[dict]:
    """GitHub Actions 등 CI 환경에서는 브라우저 프로필을 유지할 수 없으므로,
    Secrets로 넣은 NID_AUT / NID_SES 환경변수를 우선 사용합니다."""
    nid_aut = os.environ.get("NID_AUT")
    nid_ses = os.environ.get("NID_SES")
    if nid_aut and nid_ses:
        return {"NID_AUT": nid_aut, "NID_SES": nid_ses}
    return None


def get_session() -> requests.Session:
    """쿠키가 세팅된 requests.Session을 반환. 이 세션으로 모든 카페 요청을 보냅니다.
    우선순위: 1) 환경변수(NID_AUT/NID_SES, CI용) 2) 로컬 Playwright 프로필 3) 하드코딩 fallback
    """
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})

    cookies = _cookies_from_env() or _cookies_from_profile() or NAVER_COOKIES_FALLBACK
    if not cookies or not any(cookies.values()):
        raise RuntimeError(
            "로그인 세션을 찾을 수 없습니다. GitHub Actions라면 Secrets에 NID_AUT/NID_SES를 "
            "등록하거나, 로컬이라면 naver_login_setup.py를 먼저 실행해 로그인해두세요."
        )
    session.cookies.update(cookies)
    return session


def is_logged_in(session: requests.Session) -> bool:
    """
    세션 쿠키가 아직 유효한지 확인.
    TODO: 실제로는 로그인 상태에서만 보이는 요소(예: 마이페이지 응답에 닉네임 포함 여부)로
    판별하세요. 아래는 자리표시자이며, 쿠키 만료로 로그인 페이지로 리다이렉트되면
    응답 URL이나 본문에 "로그인"이 포함되는 경우가 많다는 점을 활용한 예시입니다.
    """
    resp = session.get("https://cafe.naver.com/", timeout=10)
    return "login" not in resp.url.lower()

STOPWORDS = {
    "예약", "신청", "참석", "타임", "수업", "출석", "참가", "완료",
    "회원", "오전", "오후", "저녁", "아침", "확정", "취소", "변경", "문의", "체험",
}

# 실제 예약 댓글은 항상 짧습니다("1900 김완상 7033" 등). 코치 공지처럼 긴 글 안에
# 우연히 시간/이름처럼 보이는 문구가 섞여 있어도 오인식하지 않도록, 일정 길이를
# 넘는 댓글은 예약 형식이 아니라고 보고 통째로 무시합니다.
MAX_RESERVATION_TEXT_LEN = 40

NAME_RE = re.compile(r"[가-힣]{2,5}")
PHONE_RE = re.compile(r"\d{3,4}")
CLEAN_RE = re.compile(r"[\[\]()/,·\-*]")
DROPIN_RE = re.compile(r"드랍인\s*(\d+)\s*명")
TRIAL_RE = re.compile(r"체험")


# -------------------------------------------------------------------------
# 파싱 로직 — 이전 React 버전(JS)의 정규식 로직을 Python으로 그대로 이식
# -------------------------------------------------------------------------
def extract_time(line: str):
    """댓글 맨 앞의 시간 표기를 인식한다. 콜론/시(분)/am-pm/공백없는 4자리(군대식) 순으로 시도.
    실제 예약은 항상 '시간으로 시작'하므로, 문장 중간이 아니라 맨 앞에서만 매칭한다
    (긴 공지글 안에 우연히 섞인 시간 표기를 잘못 집어내는 것을 방지)."""
    s = line.strip()
    if s.startswith("["):
        s = s[1:].lstrip()

    m = re.match(r"(\d{1,2}):(\d{2})", s)
    if m:
        h = int(m.group(1)) % 24
        return f"{h:02d}:{m.group(2)}", s[m.end():]

    m = re.match(r"(\d{1,2})\s*시\s*(\d{1,2})?\s*분?", s)
    if m:
        h = int(m.group(1))
        minute = m.group(2).zfill(2) if m.group(2) else "00"
        if re.search(r"오후|저녁|밤", line) and h < 12:
            h += 12
        if re.search(r"오전", line) and h == 12:
            h = 0
        return f"{h % 24:02d}:{minute}", s[m.end():]

    m = re.match(r"(\d{1,2})\s*(am|pm)", s, re.IGNORECASE)
    if m:
        h = int(m.group(1))
        ap = m.group(2).lower()
        if ap == "pm" and h < 12:
            h += 12
        if ap == "am" and h == 12:
            h = 0
        return f"{h:02d}:00", s[m.end():]

    # 군대식 표기: "1900", "0630", "630" 처럼 콜론/공백 없이 붙여쓴 3~4자리
    # (예: "1900김완상7033", "0630임채성1378", "630천민경9973")
    m = re.match(r"(\d{3,4})(?!\d)", s)
    if m:
        digits = m.group(1)
        if len(digits) == 3:
            h, minute = int(digits[0]), digits[1:3]
        else:
            h, minute = int(digits[0:2]), digits[2:4]
        if 0 <= h <= 23 and 0 <= int(minute) <= 59:
            return f"{h:02d}:{minute}", s[m.end():]

    return None


def classify_line(line: str) -> str:
    if re.search(r"\*?\s*취소\s*\*?", line):
        return "cancel"
    if re.search(r"\*?\s*변경\s*\*?", line):
        return "change"
    return "normal"


def extract_name_phone(text: str):
    work = text
    if ":" in work:
        work = work.split(":", 1)[1]
    work = CLEAN_RE.sub(" ", work)

    phone = None
    phones = PHONE_RE.findall(work)
    if phones:
        p = phones[-1]
        phone = p.zfill(4)[-4:]
        work = work.replace(p, " ", 1)

    name = None
    for token in NAME_RE.findall(work):
        cleaned = token[:-1] if token.endswith("님") else token
        if cleaned not in STOPWORDS and len(cleaned) >= 2:
            name = cleaned
            break

    return name, phone


def parse_reservation_entries(line: str):
    """일반/변경 줄에서 예약 항목을 추출. 보통 1건이지만, '드랍인 2명'처럼
    쓰인 경우 드랍인1, 드랍인2 ... 로 여러 건으로 확장해서 반환한다.
    '체험'이라는 단어가 포함된 줄은 이름 뒤에 "(체험)"을 붙여 화면에서
    바로 구분되게 한다(예: "10시 원재연 체험" → "원재연 (체험)").
    이름이 아예 없이 "10시 체험"만 적힌 경우는 이름을 "체험"으로 등록한다."""
    if len(line.strip()) > MAX_RESERVATION_TEXT_LEN:
        return []

    t = extract_time(line)
    if not t:
        return []
    time_str, rest = t

    dropin_match = DROPIN_RE.search(rest)
    if dropin_match:
        count = int(dropin_match.group(1))
        return [
            {"time": time_str, "name": f"드랍인{i}", "phone": "----"}
            for i in range(1, count + 1)
        ]

    is_trial = bool(TRIAL_RE.search(rest))
    name, phone = extract_name_phone(rest)
    if not name and not is_trial:
        return []

    display_name = f"{name} (체험)" if (name and is_trial) else (name or "체험")
    return [{"time": time_str, "name": display_name, "phone": phone or "----"}]


def parse_cancel_line(line: str):
    # 참고: "드랍인2 취소"처럼 번호가 매겨진 드랍인 개별 취소는 이름이 그대로
    # "드랍인2"로 적혀야 매칭됩니다. 드랍인 자체가 통째로 사라지는 경우
    # (댓글 삭제)는 재동기화(미언급 자동삭제) 단계에서 자연히 처리됩니다.
    if len(line.strip()) > MAX_RESERVATION_TEXT_LEN:
        return None

    t = extract_time(line)
    rest = t[1] if t else line
    name, phone = extract_name_phone(rest)
    if not name:
        return None
    return {"name": name, "phone": phone}


# -------------------------------------------------------------------------
# 네이버 카페 스크래핑 — 확인된 구조: 이 카페는 일반 게시판이 아니라
# 네이버가 제공하는 "출석체크(Attendance)" 전용 메뉴를 씁니다.
# 그래서 article id를 찾는 절차 자체가 필요 없고, 날짜(year/month/day)
# 파라미터로 바로 그날 데이터를 요청할 수 있습니다.
# -------------------------------------------------------------------------
ATTENDANCE_VIEW_URL = "https://m.cafe.naver.com/AttendanceView.nhn"       # 1페이지 — 기본 페이지 HTML에 li 목록이 그대로 포함됨
ATTENDANCE_AJAX_URL = "https://m.cafe.naver.com/AttendanceViewAjax.nhn"   # 2페이지부터 "더보기"가 부르는 AJAX
MAX_PAGES = 20  # 무한루프 방지용 안전장치

# 실제 "더보기" 클릭 요청을 캡처해서 확인한 값 (기본 페이지 HTML에 인라인 스크립트로 박혀 있음):
#   oApiParam: {"search.clubid":.., "search.menuid":.., "search.attendyear":.., "search.attendmonth":..,
#               "search.attendday":.., "search.totalCount": 40}, sPageParam: "search.page"
# → 2페이지 이상을 가져오려면 search.page뿐 아니라 "그날 총 댓글 수(search.totalCount)"도
#   반드시 같이 보내야 하고, 이 값은 기본 페이지를 한 번 먼저 읽어야 알 수 있다.
TOTAL_COUNT_RE = re.compile(r'"search\.totalCount"\s*:\s*(\d+)')


def _parse_comment_datetime(text: str) -> Optional[str]:
    """'2026.07.27. 15:13' 형태를 ISO 8601(+09:00, KST)로 변환."""
    text = text.strip()
    try:
        dt = datetime.strptime(text, "%Y.%m.%d. %H:%M")
        return dt.replace(tzinfo=KST).isoformat()
    except ValueError:
        return None


def _parse_attendance_html(html: str) -> list[dict]:
    """AttendanceView.nhn / AttendanceViewAjax.nhn 응답 HTML에서
    [{"text": "...", "commented_at": "ISO8601"}] 목록을 추출."""
    soup = BeautifulSoup(html, "html.parser")
    entries = []
    for li in soup.select("li.comment"):
        txt_el = li.select_one("p.txt")
        date_el = li.select_one("span.date")
        if not txt_el:
            continue
        # 네이버가 단어 사이를 &nbsp;(non-breaking space)로 채우므로 일반 공백으로 치환
        text = txt_el.get_text().replace("\xa0", " ").strip()
        commented_at = _parse_comment_datetime(date_el.get_text()) if date_el else None
        entries.append({"text": text, "commented_at": commented_at})
    return entries


def fetch_all_comments(
    session: requests.Session, club_id: str, menu_id: str, target_date: date
) -> list[dict]:
    """target_date 하루치 출석체크 댓글을 전부(페이지네이션 포함) 가져온다.
    1페이지는 기본 페이지(AttendanceView.nhn)에 이미 HTML로 포함되어 있고,
    2페이지부터는 "더보기"가 실제로 부르는 AttendanceViewAjax.nhn 요청을 그대로 재현한다."""
    base_params = {
        "search.clubid": club_id,
        "search.menuid": menu_id,
        "search.attendyear": target_date.strftime("%Y"),
        "search.attendmonth": target_date.strftime("%m"),
        "search.attendday": target_date.strftime("%d"),
    }

    first_resp = session.get(ATTENDANCE_VIEW_URL, params=base_params, timeout=15)
    first_resp.raise_for_status()

    all_entries: list[dict] = _parse_attendance_html(first_resp.text)
    seen_signatures = {(e["text"], e["commented_at"]) for e in all_entries}

    m = TOTAL_COUNT_RE.search(first_resp.text)
    total_count = int(m.group(1)) if m else len(all_entries)

    # "더보기"가 없거나(=1페이지에 이미 전부 있음) 이미 다 모았으면 바로 종료
    if len(all_entries) >= total_count:
        return all_entries

    for page in range(2, MAX_PAGES + 2):
        params = {**base_params, "search.totalCount": total_count, "search.page": page}
        resp = session.get(ATTENDANCE_AJAX_URL, params=params, timeout=15)
        resp.raise_for_status()
        page_entries = _parse_attendance_html(resp.text)

        if not page_entries:
            break  # 더 이상 댓글 없음 → 마지막 페이지

        # 페이지가 이전과 완전히 겹치면(=파라미터가 또 달라져서 서버가 같은 페이지만
        # 주는 경우 등) 무한루프에 빠지지 않도록 방어
        new_count = 0
        for e in page_entries:
            sig = (e["text"], e["commented_at"])
            if sig in seen_signatures:
                continue
            seen_signatures.add(sig)
            all_entries.append(e)
            new_count += 1

        if new_count == 0 or len(all_entries) >= total_count:
            break

    if len(all_entries) < total_count:
        print(
            f"[경고] {target_date}: 총 {total_count}개 중 {len(all_entries)}개만 수집됨 "
            "(더보기 파라미터가 또 바뀐 것일 수 있음 — 재확인 필요)"
        )

    return all_entries


# -------------------------------------------------------------------------
# Supabase 재동기화
# -------------------------------------------------------------------------
def sync_reservations(supabase, target_date: str, comment_entries: list[dict]) -> dict:
    """comment_entries: [{"text": "...", "commented_at": "ISO8601 또는 None"}, ...]"""
    existing = (
        supabase.table("reservations").select("*").eq("date", target_date).execute().data
    )
    existing_by_key = {(r["time"], r["name"], r["phone"]): r for r in existing}

    cancels, changes, normals = [], [], []
    for entry in comment_entries:
        text = (entry.get("text") or "").strip()
        commented_at = entry.get("commented_at")
        if not text:
            continue
        kind = classify_line(text)
        if kind == "cancel":
            r = parse_cancel_line(text)
            if r:
                cancels.append(r)
        elif kind == "change":
            for r in parse_reservation_entries(text):
                changes.append({**r, "commented_at": commented_at})
        else:
            for r in parse_reservation_entries(text):
                normals.append({**r, "commented_at": commented_at})

    # 최종 active 예약자 집합: (name, phone) -> {"time":, "commented_at":}
    active: dict[tuple, dict] = {}
    change_keys = set()
    for n in normals:
        active[(n["name"], n["phone"])] = {"time": n["time"], "commented_at": n["commented_at"]}
    for c in changes:
        active[(c["name"], c["phone"])] = {"time": c["time"], "commented_at": c["commented_at"]}
        change_keys.add((c["name"], c["phone"]))
    for c in cancels:
        for key in list(active.keys()):
            # "(체험)" 접미사가 붙은 이름도 취소 댓글의 원래 이름으로 매칭되게 함
            # (예: 활성 키 "원재연 (체험)" ↔ 취소 댓글 "원재연 취소")
            name_matches = key[0] == c["name"] or key[0].startswith(f"{c['name']} (")
            if name_matches and (c["phone"] is None or key[1] == c["phone"]):
                active.pop(key, None)

    # 기존 (name, phone) -> 이전 시간 / 출석여부 / 변경이력
    prev_time_by_member = {}
    attended_by_member = {}
    changed_by_member = {}
    for (t, n, p), row in existing_by_key.items():
        prev_time_by_member[(n, p)] = t
        attended_by_member[(n, p)] = row.get("attended", False)
        changed_by_member[(n, p)] = row.get("changed", False)

    new_rows = []
    for (name, phone), info in active.items():
        time_str = info["time"]
        old_time = prev_time_by_member.get((name, phone))
        # 시간이 실제로 달라졌을 때만 출석을 초기화 (동일 시간이면 기존 출석 유지)
        attended = attended_by_member.get((name, phone), False) if old_time == time_str else False
        changed_flag = (name, phone) in change_keys or changed_by_member.get((name, phone), False)
        new_rows.append(
            {
                "date": target_date,
                "time": time_str,
                "name": name,
                "phone": phone,
                "attended": attended,
                "changed": changed_flag,
                "commented_at": info["commented_at"],
            }
        )

    supabase.table("reservations").delete().eq("date", target_date).execute()
    if new_rows:
        supabase.table("reservations").insert(new_rows).execute()

    return {
        "before": len(existing),
        "after": len(new_rows),
        "cancels_detected": len(cancels),
        "changes_detected": len(changes),
    }


def main():
    supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    today = date.today()

    session = get_session()
    if not is_logged_in(session):
        # 쿠키 만료 시 여기서 바로 실패시켜야, "댓글이 하나도 없음"으로 오인해
        # 예약자를 전부 자동 삭제해버리는 사고를 막을 수 있습니다.
        # (필요하면 이 지점에 Slack/이메일 알림을 추가해 쿠키를 다시 넣어야 함을 바로 알리세요.)
        raise RuntimeError(
            "네이버 로그인 세션이 만료된 것으로 보입니다. NAVER_COOKIES를 새로 갱신해주세요. "
            "이번 실행은 재동기화를 건너뜁니다."
        )

    comment_entries = fetch_all_comments(session, NAVER_CLUB_ID, NAVER_MENU_ID, today)

    result = sync_reservations(supabase, today.isoformat(), comment_entries)
    print(f"[{today.isoformat()}] 재동기화 완료: {result}")


if __name__ == "__main__":
    main()
