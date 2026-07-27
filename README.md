# Bebold Boramae 출석/예약 현황판 — 온라인 무료 테스트 배포

구성: GitHub(코드 저장) + Supabase(무료 DB) + Vercel(무료 웹 호스팅) + GitHub Actions(무료 5분 주기 실행)

자세한 단계는 대화에서 안내한 가이드를 따라주세요. 요약:

1. 이 폴더를 GitHub 저장소로 push
2. Supabase 프로젝트 생성 → `supabase_schema.sql` 실행 → URL/anon key/service_role key 확보
3. Vercel에서 저장소 import, Root Directory를 `web`으로 지정, 환경변수
   `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` 등록 → 배포
4. GitHub 저장소 Settings > Secrets and variables > Actions 에 다음 등록:
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NAVER_CLUB_ID`, `NAVER_MENU_ID`,
   `NID_AUT`, `NID_SES`
5. `.github/workflows/naver-sync.yml`이 5분마다 `scripts/naver_cafe_sync.py`를 실행
