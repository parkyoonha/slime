# Slime sound samples

이 폴더에 슬라임 squish 샘플 파일을 넣으면 앱이 자동으로 감지해서 재생합니다.

## 파일 이름 규칙

```
public/sounds/squish_1.mp3
public/sounds/squish_2.mp3
public/sounds/squish_3.mp3
...
public/sounds/squish_8.mp3
```

- 최대 **8개** 까지 로드됨
- 파일이 없거나 로드 실패하면 조용히 스킵 (기본 절차적 합성으로 폴백)
- 랜덤으로 골라 재생하니 3개만 넣어도 반복 티는 안 남 (많을수록 자연스러움)

## 파일 요구사항

- **포맷**: mp3 (권장) 또는 wav
- **길이**: 각 클립 100~500ms 정도가 이상적
  - 너무 길면 다음 squelch랑 겹쳐서 지저분해짐
- **내용**: 앞뒤 무음 트림된 순수 squish 소리 하나
  - 예: 슬라임 눌러서 나는 "쩝", 손 뗄 때 "뽁", 반죽 짓이길 때 "찌익"
- **볼륨**: 정규화된 -3dB 정도가 자연스러움 (크기는 앱이 강도에 따라 조절)

## 파일 확장자를 mp3 대신 wav로 쓰려면

`src/components/SlimeApp.tsx` 상단의 `SQUISH_SAMPLE_URLS` 배열에서 `.mp3` 를 `.wav` 로 변경.

## 크랙 사운드는?

크랙(왁스 깨짐)은 아직 절차적 합성만 씀. 필요하면 같은 방식으로 확장 가능.
