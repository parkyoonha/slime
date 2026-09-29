# 왁부 슬라임 — 로그인/구독 셋업

## 1. 로컬 환경변수 (.env.local)

`.env.example`를 `.env.local`로 복사하고 값 채우기. `.env.local`은 gitignored.

```
VITE_SUPABASE_URL=...              # Supabase → Project Settings → API → Project URL
VITE_SUPABASE_ANON_KEY=...         # 같은 페이지의 "anon public" 키
VITE_RC_ANDROID_KEY=goog_...       # RevenueCat → Project settings → API keys → Public (Android)
VITE_OAUTH_REDIRECT_URL=io.wakbu.slime://auth/callback
VITE_RC_ENTITLEMENT_ID=premium     # RevenueCat entitlement 이름
VITE_FREE_DAILY_LIMIT=5
```

## 2. Supabase

### 2-1. 스키마
Supabase Dashboard → SQL Editor에서 [supabase/schema.sql](supabase/schema.sql) 전체 실행. profiles·daily_usage·RPC·RLS 정책이 만들어짐.

### 2-2. Auth Providers
Authentication → Providers 에서:
- **Google**: enabled = on. Google Cloud Console에서 발급받은 Web OAuth Client의 Client ID / Secret 입력.
  - Google Cloud → OAuth consent screen을 먼저 설정. Authorized redirect URI에 `https://<PROJECT>.supabase.co/auth/v1/callback` 추가.
- **Kakao**: enabled = on. Kakao Developers → 애플리케이션 → 앱 설정에서 REST API 키 / Client Secret 입력.
  - 카카오 → 카카오 로그인 → Redirect URI에 `https://<PROJECT>.supabase.co/auth/v1/callback` 추가.

### 2-3. Redirect URLs
Authentication → URL Configuration → Redirect URLs 에 추가:
- `io.wakbu.slime://auth/callback`
- 로컬 웹 개발용: `http://localhost:5173`

## 3. RevenueCat

1. RevenueCat 대시보드에서 프로젝트 생성 (또는 기존 프로젝트 선택).
2. **Apps** → Android 앱 추가. Package name: `io.wakbu.slime`. Google Service Account JSON 업로드.
3. **Products** → Google Play Console에 등록한 구독 SKU (예: `premium_monthly`, `premium_yearly`) import.
4. **Entitlements** → `premium` entitlement 생성 후 두 상품 attach.
5. **Offerings** → 기본 offering 생성. `monthly` / `annual` 패키지에 위 상품 배정.
6. **API keys** → Android public key를 `.env.local`의 `VITE_RC_ANDROID_KEY`에 넣기.

### 3-1. Webhook → Supabase (선택, 강력 권장)
RevenueCat → **Integrations → Webhooks**로 구독 상태 변경 이벤트를 Supabase Edge Function에 push해서 `profiles.is_premium` / `premium_expires_at`을 서버 authoritative하게 유지. (이 부분은 후속 작업)

## 4. Google Play Console

1. 앱 등록 및 내부 테스트 트랙 생성.
2. Monetization → Subscriptions → 상품 생성:
   - `premium_monthly` (월간, ₩자율)
   - `premium_yearly` (연간)
3. Base plan 각각 활성화, 상태 = Active.
4. 라이선스 테스터에 개발/QA 계정 등록 (Settings → License testing).
5. Play Console → Service Account 만들어서 RevenueCat에 credential 연결.

## 5. Google Cloud Console (Android OAuth 서명 인증서 등록 필요)

Google 로그인이 Android에서 정상 동작하려면:
1. `keytool -list -v -keystore <keystore>` 로 debug / release SHA-1 확인.
2. Google Cloud → Credentials → Android OAuth client 생성 (package: `io.wakbu.slime`, SHA-1 등록).
3. Web OAuth client의 ID/Secret은 Supabase에, Android OAuth client는 SHA-1 등록용.

## 6. Kakao Developers

1. 애플리케이션 → 플랫폼 → Android 추가. 패키지명 `io.wakbu.slime`, key hash 등록.
2. 카카오 로그인 활성화. Redirect URI에 Supabase 콜백 등록 (위 참조).

## 7. Capacitor 동기화

```
npm run build
npx cap sync android
```

Android Studio에서 열어 빌드 → 실기기에서 테스트. Deep-link intent-filter는 [android/app/src/main/AndroidManifest.xml](android/app/src/main/AndroidManifest.xml)에 이미 추가되어 있음 (scheme `io.wakbu.slime`, host `auth`).

## 8. 동작 흐름 요약

1. 앱 시작 → AuthContext 세션 확인 → 세션 없으면 `LoginScreen`.
2. Google/Kakao 버튼 → Capacitor Browser로 Supabase OAuth URL 오픈.
3. 인증 완료 → OS가 `io.wakbu.slime://auth/callback?code=...` 로 앱 재진입.
4. AuthContext의 `appUrlOpen` 리스너가 code 파싱 → `exchangeCodeForSession`.
5. 세션 확립 후 `PremiumGate` 하위로 `SlimeApp` 렌더.
6. 세션당 1회 `increment_daily_usage` RPC 호출. 하루 `VITE_FREE_DAILY_LIMIT` (기본 5) 초과 시 `Paywall` 표시.
7. Paywall에서 구독 시 RevenueCat 결제. 성공 시 `usePremium` 훅이 자동 갱신, 게이트 해제.
