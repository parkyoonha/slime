# Play Console — App content 11개 항목 답변 가이드

Play Console → **App content** 페이지의 모든 항목별 정답 & 주의사항.
각 항목은 클릭하면 별도 페이지로 이동해서 폼 작성 → 저장하면 체크됨.

---

## 1. ✅ 개인정보처리방침 설정 (완료)
- URL: `https://parkyoonha.github.io/slimong-policy/`

---

## 2. 🔐 로그인 세부정보 (App access)

Play 리뷰어가 앱을 테스트할 때 로그인 필요 여부.

### Q: 앱의 일부/전체 기능이 로그인이나 특정 조건에서만 이용 가능한가요?
**답: Yes — 모든 기능이 로그인 뒤에만 이용 가능**

### 리뷰어용 테스트 자격증명 제공 필요
soundslime은 진입 전 로그인 필수 → **Play 리뷰어가 앱을 테스트하려면 계정이 필요**함.

**옵션 A — 테스트용 Google 계정 만들어 제공 (권장)**
1. 별도 Google 계정 생성 (예: `wakbu.reviewer@gmail.com`)
2. Supabase → Authentication → Providers → Google OAuth consent screen에서 Test users에 이 계정 추가
3. Play Console 폼에 아래 형식으로 입력:

```
Instructions: 
1. Open the app
2. Tap "Google로 계속하기"
3. Sign in with the provided test account below

Username: wakbu.reviewer@gmail.com
Password: <제공할 비번>

Any other instructions:
The app requires camera permission for optional hand tracking. 
You can skip granting it and still use all features via touch.
```

**옵션 B — 로그인 우회 기능 추가 (더 복잡)**
- 앱 내에 리뷰어 전용 게스트 진입 코드 심기
- Play 리뷰용으로만 사용
- 시간 없으면 옵션 A 권장

---

## 3. 📢 광고 (Ads)

### Q: 앱에 광고가 포함되어 있나요?
**답: No — 광고 없음** (`No, my app does not contain ads`)

이 앱은 광고 미탑재. Google AdMob/AdSense 등 사용 안 함.

---

## 4. 🎯 콘텐츠 등급 (Content rating)

설문지 답변 → 자동으로 등급(3+/12+/16+/18+) 부여.

### 예상 답변 (모두 No)
- 폭력적 콘텐츠? **No**
- 성적 콘텐츠? **No**
- 욕설/부적절한 언어? **No**
- 통제 물질(마약/술)? **No**
- 도박? **No**
- 사용자 상호작용 (채팅/공유)? **No** (현재 슬라임 공유 기능 제거함)
- 위치 공유? **No**
- 개인정보 공유(이름/이메일)? **Yes** (로그인 시 수집 → 이건 정직하게 답)
- 디지털 상품 구매(IAP)? **Yes** (프리미엄 구독)

예상 등급: **3+ 또는 전체 이용가 (Everyone)**

**주의**: 이메일은 리뷰어가 이용 가능한 이메일을 넣어야 함. 등급 확정 후 이메일로 인증 링크 옴 → 확인해야 등급 확정.

---

## 5. 👥 타겟층 (Target audience and content)

### Q: 앱의 타겟 연령대는?
**답: 13세 이상 (13+ / 18+)**

권장: **13세 이상**
- 힐링·스트레스 관리 앱이라 성인 취향이지만 청소년도 이용 가능
- 만 13세 미만 대상이면 Google Play Families 정책 적용됨 → 매우 엄격 (개인정보 수집 제한, COPPA 준수 등)
- **아동 대상 아님을 명확히 선언**

### Q: 아동에게 매력적인가?
**답: No** (귀엽지만 명시적으로 아동 대상은 아님)

---

## 6. 🔒 데이터 보안 (Data safety)

→ 별도 문서 [play-data-safety.md](play-data-safety.md) 참조. 모든 항목 정리돼 있음.

---

## 7. 🏛 정부 앱 (Government apps)

### Q: 이 앱은 정부 조직에서 개발/승인/의뢰한 앱인가요?
**답: No** (개인 개발)

---

## 8. 💰 금융 기능 (Financial features)

### Q: 앱에 금융 기능(대출/보험/투자/암호화폐/송금 등)이 있나요?
**답: No**

프리미엄 구독은 Google Play 결제 시스템을 통한 일반 인앱결제라 여기에 해당 안 됨.

---

## 9. 🏥 건강 (Health)

### Q: 앱이 건강 기능을 제공하나요? (의료 정보/피트니스 트래킹 등)
**답: No**

"힐링/스트레스 해소" 컨셉이지만 건강 데이터를 수집·제공하지 않음.
(만약 향후 명상 트래킹, 심박수 측정 등 추가하면 재선언 필요)

---

## 10. 📰 뉴스 앱 (News app) — 만약 있으면

### Q: 뉴스 앱인가요?
**답: No**

---

## 11. 🦠 COVID-19 접촉 추적 앱 — 만약 있으면

### Q: COVID-19 접촉 추적 또는 상태 관련 앱인가요?
**답: No**

---

## ✅ 진행 순서 추천

빠른 것부터 정리:
1. 광고 → No
2. 정부 앱 → No
3. 금융 기능 → No
4. 건강 → No
5. (뉴스/COVID 있으면) → No
6. 타겟층 → 13세 이상
7. 로그인 세부정보 → Yes + 리뷰어 계정 준비
8. 콘텐츠 등급 → 설문지 답변
9. 데이터 보안 → [play-data-safety.md](play-data-safety.md) 참조

---

## ⚠️ 리뷰어 계정 준비가 병목

**로그인 세부정보**에 리뷰어 계정 안 넣으면 → 리뷰 반드시 실패 ("앱을 열 수 없음").

**추천 흐름**:
1. 새 Gmail 계정 생성 (예: `slimong.review@gmail.com`)
2. Supabase → Auth → Providers → Google → **Advanced settings** 확인
3. Google Cloud Console → OAuth consent screen → **Test users**에 위 계정 추가
4. Play Console 로그인 세부정보에 계정 정보 입력

**앱이 프로덕션 상태(Production tier)로 갈 때**: Google Cloud의 OAuth consent screen을 **Testing → In production**으로 승격 → Google이 앱 검증 (스크린샷/데모 영상 필요)

지금 내부 테스트 단계에선 Testing 상태로 충분.
