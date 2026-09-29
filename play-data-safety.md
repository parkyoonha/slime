# Play Console — Data Safety 답변 가이드

Play Console → **App content → Data safety**에서 물어보는 순서대로 답 정리.
잘못 선언하면 Play 정책 위반으로 앱 정지 사유가 되므로, 실제 앱 동작과 일치하게 답할 것.

---

## 1단계 — Data collection and security (개요)

### Q1. 앱이 필수 사용자 데이터 유형을 수집하거나 공유합니까?
**답: Yes**
(이메일, 이름, 결제 정보 등을 수집하므로)

### Q2. 앱이 수집한 모든 데이터가 전송 중에 암호화됩니까?
**답: Yes**
(Supabase, RevenueCat, Google Play 모두 HTTPS/TLS 사용)

### Q3. 사용자가 데이터 삭제를 요청할 방법을 제공합니까?
**답: Yes**
- 앱 내 로그아웃 후 이메일(`grttihat@gmail.com`)로 계정 삭제 요청
- 또는 웹으로 개인정보처리방침 페이지의 연락처를 통해 요청

> ⚠️ 이상적으로는 앱 내에 "계정 삭제" 버튼도 있어야 함. 아직 없으니 나중에 추가 필요 (Google이 앱 내 삭제 옵션도 강조 중).

### Q4. 앱이 Google Play Families 정책을 준수합니까? / 아동 대상입니까?
**답: 아동 대상 아님 (Not primarily aimed at children)**
(만 14세 미만 대상 아님 — privacy-policy에도 명시)

---

## 2단계 — Data types (수집 데이터 유형별)

Play Console에 카테고리별로 나열됨. 각 항목에 "Collected? / Shared? / Optional? / Purposes"를 답.

### ✅ Personal info

**Name (이름)**
- Collected: **Yes**
- Shared: **No**
- Processing: **Processed ephemerally: No** (계정에 저장됨)
- Optional: **No — required**
- Purposes: **Account management, Personalization**

**Email address (이메일 주소)**
- Collected: **Yes**
- Shared: **No**
- Optional: **No — required**
- Purposes: **Account management, App functionality**

**User IDs (사용자 ID)**
- Collected: **Yes**
- Shared: **Yes** (RevenueCat에 유저 식별용으로 전달)
- Optional: **No — required**
- Purposes: **Account management, App functionality, Fraud prevention**

**Other info (기타 개인정보)** — 프로필 사진 URL
- Collected: **Yes**
- Shared: **No**
- Optional: **Yes**
- Purposes: **Personalization**

**해당 없음**: Address, Phone number, Race and ethnicity, Political or religious beliefs, Sexual orientation

---

### ✅ Financial info

**Purchase history (구매 내역)**
- Collected: **Yes**
- Shared: **Yes** (RevenueCat이 처리)
- Optional: **No** (프리미엄 이용 시 필수)
- Purposes: **App functionality, Fraud prevention, Account management**

**해당 없음**: Credit card info(카드번호는 Google Play가 처리 — 앱은 절대 안 봄), Credit score, Other financial info

---

### ✅ App activity

**App interactions (앱 상호작용)**
- Collected: **Yes** (daily_usage 카운터)
- Shared: **No**
- Optional: **No — required** (무료 tier 한도 관리에 필요)
- Purposes: **App functionality, Analytics**

**해당 없음**: In-app search history, Installed apps, Other user-generated content, Other actions (예: 좋아요, 리액션 등 없음)

---

### ✅ Device or other IDs

**Device or other IDs**
- Collected: **Yes** (Google Play 결제·RevenueCat이 기기 식별용)
- Shared: **Yes** (RevenueCat에)
- Optional: **No**
- Purposes: **Analytics, Fraud prevention, App functionality**

---

### ❌ 다음은 모두 **No (수집 안 함)**로 답

| 카테고리 | 항목 | 이유 |
|---|---|---|
| Location | Approximate/Precise | 위치 미사용 |
| Photos and videos | Photos, Videos | 촬영/저장 안 함 |
| Audio files | Voice/sound recordings, Music files, Other audio | 오디오 녹음 없음 |
| Files and docs | Files and docs | 파일 접근 없음 |
| Calendar | Calendar events | 미사용 |
| Contacts | Contacts | 미사용 |
| Health and fitness | Health info, Fitness info | 미사용 |
| Messages | Emails, SMS/MMS, Other in-app | 미사용 |
| Web browsing | Web browsing history | 미사용 |

---

### ⚠️ 카메라(Camera) — 주의 필요

- 앱은 **손 인식용으로 카메라 권한**을 요청함 (MediaPipe)
- **하지만 이미지/영상은 서버로 전송하거나 저장하지 않음** — 기기 내부에서만 실시간 처리
- Play Console의 "Data types" 관점에서는 **수집하지 않음(No)** 으로 답
- 대신 **App permissions** 섹션에서 카메라 권한 사용 목적을 별도 설명해야 함
  - 예: "손 동작 인식을 통한 슬라임 조작에만 사용됩니다. 촬영된 이미지는 기기 내부에서 실시간으로 처리되고 즉시 폐기되며, 서버로 전송되거나 저장되지 않습니다."

---

## 3단계 — Data security practices (요약 표시용)

이 항목들은 Q1~Q3 답변을 종합해서 자동으로 앱 페이지에 표시됨:

- ✅ Data is encrypted in transit
- ✅ You can request that data be deleted
- ✅ App collects: Personal info, Financial info, App activity, Device IDs
- ✅ App shares with third parties: Personal info(User IDs), Financial info(Purchase history), Device IDs
- ❌ App does not collect: Location, Photos/Videos, Audio, Files, Calendar, Contacts, Health, Messages, Web history

---

## ✅ 저장하기 전 최종 체크

- [ ] 개인정보처리방침 URL(`https://parkyoonha.github.io/slimong-policy/`) 입력
- [ ] 실제 앱 동작과 declaration 일치 (거짓 선언 시 Play 정책 위반)
- [ ] Save → Submit for review

## 나중에 추가하면 좋은 것 (필수는 아님)

1. **앱 내 계정 삭제 기능** — 로그아웃 옆에 "계정 완전 삭제" 버튼. Google이 강력 권고.
2. **동의 배너** — 첫 로그인 시 데이터 수집 동의 팝업. 유럽(GDPR) 대응.
