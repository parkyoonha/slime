# 슬라이멍 개인정보처리방침 호스팅

이 폴더의 `index.html`을 인터넷에 공개된 URL로 호스팅하는 방법.
Play Console의 App content → Privacy policy 필드에 그 URL을 입력.

## 가장 쉬운 방법: GitHub Pages (무료, 10분)

### 1. GitHub 계정 준비
없으면 https://github.com/signup 에서 가입.

### 2. 저장소 생성
- https://github.com/new
- Repository name: `slimong-policy` (또는 원하는 이름)
- Public 선택
- **Add a README file** 체크
- Create repository

### 3. index.html 업로드
- 방금 만든 저장소에서 **Add file → Upload files**
- 이 폴더의 `index.html`을 드래그
- 하단에 커밋 메시지 아무거나 → **Commit changes**

### 4. Pages 활성화
- 저장소 상단 **Settings** 탭
- 좌측 **Pages** 메뉴
- Source: **Deploy from a branch**
- Branch: `main` / `/ (root)` → **Save**
- 1~2분 기다리면 Pages 페이지 상단에 URL이 뜸:
  ```
  https://<username>.github.io/slimong-policy/
  ```

### 5. Play Console에 URL 입력
Play Console → App content → **Privacy policy** → URL 붙여넣고 저장.

---

## 대안: 자체 도메인 (slimong.com)이 이미 있다면

`index.html`을 웹 호스팅에 `privacy` 폴더로 올려서:
```
https://slimong.com/privacy/
```
같은 URL로 접근 가능하게 만들고 Play Console에 그 URL 입력.

---

## 나중에 내용 수정하려면

GitHub 저장소의 `index.html`을 수정하고 커밋하면 자동 반영됨 (수 초).
반드시 시행일(`<p class="meta">`)도 새 날짜로 갱신하고, 하단
"개정 이력" 섹션에 변경 사항 한 줄 추가.
