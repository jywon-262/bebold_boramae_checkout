"""
BEBOLD BORAMAE · 네이버 로그인 세션 최초 설정 스크립트
=========================================================================
딱 한 번만 실행하면 됩니다. 실행하면 실제 크롬 창이 뜨고, 그 창에서
평소처럼 네이버에 직접 로그인하면 그 로그인 세션이 NAVER_PROFILE_DIR
폴더에 저장됩니다. 이후 naver_cafe_sync.py는 매번 이 폴더에서 최신 쿠키를
자동으로 꺼내 쓰기 때문에, 쿠키 값을 손으로 복사해 코드에 넣을 필요가
없어집니다.

세션이 완전히 만료되거나(네이버 쪽 정책으로 강제 로그아웃 등) 브라우저
프로필이 손상된 경우에만 이 스크립트를 다시 한번 실행해서 재로그인하면
됩니다 — 보통 몇 주~몇 달에 한 번 정도로 훨씬 뜸해집니다.

필요 패키지: pip install playwright
최초 1회:    playwright install chromium
=========================================================================
"""

from pathlib import Path
from playwright.sync_api import sync_playwright

# naver_cafe_sync.py의 NAVER_PROFILE_DIR과 반드시 동일한 경로로 맞추세요.
NAVER_PROFILE_DIR = Path.home() / ".bebold_naver_profile"


def main():
    NAVER_PROFILE_DIR.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        # headless=False 로 실제 창을 띄워서 사람이 직접 로그인합니다.
        context = p.chromium.launch_persistent_context(
            user_data_dir=str(NAVER_PROFILE_DIR),
            headless=False,
        )
        page = context.new_page()
        page.goto("https://nid.naver.com/nidlogin.login")

        print("브라우저 창에서 네이버에 로그인해주세요.")
        print("로그인 후 카페 게시판이 정상적으로 보이는지 확인하고,")
        print("이 터미널로 돌아와 Enter 키를 누르면 창이 닫히고 세션이 저장됩니다.")
        input("로그인 완료 후 Enter >>> ")

        context.close()

    print(f"세션 저장 완료: {NAVER_PROFILE_DIR}")
    print("이제 naver_cafe_sync.py를 그대로 실행하면 이 세션을 자동으로 사용합니다.")


if __name__ == "__main__":
    main()
