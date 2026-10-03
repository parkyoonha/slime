/** Shared translation dictionaries. Add a new key here, add both KO + EN
 *  values, then use it via `useT()` in a component. */

export type Locale = 'ko' | 'en'

/** Korean → English label lookups. Covers preset labels (colors, materials,
 *  shapes, coatings, sprinkles, themes) AND inline UI strings scattered
 *  throughout SlimeApp / CustomizePanel. If a lookup misses, the Korean
 *  string is returned as-is (safe fallback). */
export const EN_LABELS: Record<string, string> = {
  // Colors (COLORS)
  '화이트': 'White',
  '핑크': 'Pink',
  '피치': 'Peach',
  '레몬': 'Lemon',
  '민트': 'Mint',
  '하늘': 'Sky',
  '라벤더': 'Lavender',
  '루비': 'Ruby',
  '골드': 'Gold',
  '실버': 'Silver',
  '코랄': 'Coral',
  '아쿠아': 'Aqua',
  '블랙': 'Black',
  // Foil colors
  '금색': 'Gold',
  '은색': 'Silver',
  '자주색': 'Magenta',
  '민트색': 'Mint',
  '먹색': 'Ink',
  '코코아': 'Cocoa',
  // Materials
  '크리스탈': 'Crystal',
  '광택': 'Glossy',
  '폼': 'Foam',
  '퍼티': 'Putty',
  '소프트': 'Soft',
  '아이스': 'Ice',
  // Coatings
  '없음': 'None',
  '씬왁스': 'Thin wax',
  '왁스': 'Wax',
  '박지': 'Foil',
  '젤': 'Gel',
  '글레이즈': 'Glaze',
  // Shapes / bead shapes
  '구': 'Sphere',
  '네모': 'Cube',
  '직사각형': 'Rectangle',
  '큐브': 'Cube',
  '도넛': 'Donut',
  '별': 'Star',
  '하트': 'Heart',
  '원반': 'Disc',
  // Bead materials
  '플라스틱': 'Plastic',
  '진주': 'Pearl',
  // Bead combos
  '미선택': 'None',
  '미니 꽉 채우기': 'Mini fill',
  '속비즈': 'Inner beads',
  // Sprinkle colors (extra)
  '로즈골드': 'Rose gold',
  '홀로': 'Holo',
  // Sprinkle shapes
  '점': 'Dot',
  '막대': 'Bar',
  '다이아': 'Diamond',
  // Sprinkle finish
  '무광': 'Matte',
  '반짝이': 'Glitter',
  '홀로그램': 'Hologram',
  '분필': 'Chalk',
  // Sprinkle categories
  '스팽글': 'Spangle',
  '가루': 'Powder',
  '잉크': 'Ink',
  // Spangle material
  '종이': 'Paper',
  // Attribute labels
  '종류': 'Kind',
  '크기': 'Size',
  '양': 'Amount',
  '색상': 'Color',
  '모양': 'Shape',
  '재질': 'Material',
  // Preset themes
  '심해': 'Deep sea',
  '우주': 'Space',
  '정글': 'Jungle',
  '크리스마스': 'Christmas',
  '봄': 'Spring',
  '여름': 'Summer',
  '가을': 'Autumn',
  '겨울': 'Winter',
  '사파리': 'Safari',
  '목장': 'Ranch',
  '판다': 'Panda',
  '유니콘': 'Unicorn',
  '발렌타인': 'Valentine',
  '할로윈': 'Halloween',
  '생일': 'Birthday',
  '디저트': 'Dessert',
  '과일': 'Fruit',
  '열대': 'Tropical',
  '새해': 'New year',
  '마법': 'Magic',
  // Common inline UI
  '저장': 'Save',
  '저장하기': 'Save',
  '취소': 'Cancel',
  '닫기': 'Close',
  '확인': 'OK',
  '삭제': 'Delete',
  '수정': 'Edit',
  '수정하기': 'Edit',
  '적용': 'Apply',
  '초기화': 'Reset',
  '되돌리기': 'Undo',
  '공유': 'Share',
  '복사': 'Copy',
  '이름 없음': 'Untitled',
  '슬라임': 'Slime',
  '슬라임볼': 'Slime ball',
  '슬라임멍': 'Slime zone',
  '컬렉션': 'Collection',
  '비즈': 'Beads',
  '비즈볼': 'Bead balls',
  '이모지': 'Emoji',
  '이모지비즈': 'Emoji beads',
  '커스텀비즈': 'Custom beads',
  '스프링클': 'Sprinkles',
  '텍스트': 'Text',
  '카메라': 'Camera',
  '손 감지': 'Hand tracking',
  '자동 압박': 'Auto press',
  '사용자': 'User',
  '구독': 'Subscribe',
  '테마': 'Theme',
  '라이트': 'Light',
  '다크': 'Dark',
  '언어': 'Language',
  '메뉴': 'Menu',
  '추가비즈': 'Add-on beads',
  '코팅': 'Coating',
  '납작함': 'Flatness',
  '두께': 'Thickness',
  '꽉': 'Full',
  '색조 조절': 'Hue',
  '명도 조절': 'Brightness',
  '슬라임 안': 'Inside slime',
  '텍스트 입력': 'Enter text',
  '텍스트 지우기': 'Clear text',
  '그라데이션 토글': 'Toggle gradient',
  '비즈 양': 'Bead amount',
  '비즈 크기': 'Bead size',
  '꽉비즈 납작함': 'Pack flatness',
  '스프링클 양': 'Sprinkle amount',
  '스프링클 크기': 'Sprinkle size',
  '속슬라임 양': 'Inner-slime amount',
  '속슬라임 크기': 'Inner-slime size',
  '사진 지우기': 'Clear photo',
  '사진 슬라임': 'Photo slime',
  '사진 스티커 교체': 'Replace photo sticker',
  '사진 교체': 'Replace photo',
  '사진 인쇄': 'Print photo',
  '추가비즈 양': 'Add-on bead amount',
  '추가비즈 크기': 'Add-on bead size',
  '추가비즈 두께': 'Add-on bead thickness',
  '이모지 양': 'Emoji amount',
  '이모지 크기': 'Emoji size',
  // SlimeApp toasts / dialogs / statuses
  '저장되었어요': 'Saved',
  '링크가 복사되었습니다': 'Link copied',
  '공유 실패': 'Share failed',
  '내가 만든 슬라임 놀아봐!': 'Check out the slime I made!',
  '카메라 권한 요청 중…': 'Requesting camera permission…',
  '손 인식 모델 로딩 중…': 'Loading hand-tracking model…',
  '준비 중…': 'Preparing…',
  '저장된 슬라임이 없습니다': 'No saved slimes yet',
  '이모지 / 비즈 위치 변경': 'Move emoji / beads',
  '자동 압박 중': 'Auto press on',
  '자동 압박 시작': 'Start auto press',
  '자동 압박 남은 시간 (탭하여 조정)': 'Auto-press time left (tap to adjust)',
  '분 감소': 'Minute down',
  '분 증가': 'Minute up',
  '초 감소': 'Second down',
  '초 증가': 'Second up',
  '슬라임 리셋': 'Reset slime',
  '손 감지 끄기': 'Hand tracking off',
  '손 감지 켜기': 'Hand tracking on',
  '모든 옵션 초기화': 'Reset all options',
  '압박 리셋': 'Reset press',
  '비즈 꽉': 'Beads full',
  '커스텀 사진': 'Custom photo',
  '옵션': 'Option',
  '제거': 'Remove',
  '선택 해제': 'Deselect',
  '전체선택': 'Select all',
  '삭제 선택 해제': 'Cancel delete',
  '삭제 선택': 'Select to delete',
  '컬렉션 닫기': 'Close collection',
  '슬라임 이름': 'Slime name',
  '이름 수정': 'Edit name'
}

export const MESSAGES = {
  login: {
    tagline: {
      ko: '로그인하고 나만의 슬라임을 저장해보세요.',
      en: 'Sign in to save and share your slime.'
    },
    google: { ko: 'Google로 계속하기', en: 'Continue with Google' },
    kakao: { ko: '카카오로 계속하기', en: 'Continue with Kakao' },
    connecting: { ko: '연결 중…', en: 'Connecting…' },
    error: {
      ko: '로그인에 실패했어요. 다시 시도해주세요.',
      en: 'Sign-in failed. Please try again.'
    }
  },
  splash: { loading: { ko: '불러오는 중…', en: 'Loading…' } },
  account: {
    subscription: { ko: '구독 상태', en: 'Subscription' },
    premium: { ko: '프리미엄', en: 'Premium' },
    freeUsage: {
      ko: (n: number, l: number) => `무료 (${n}/${l} 사용)`,
      en: (n: number, l: number) => `Free (${n}/${l} used)`
    },
    freeShort: {
      ko: (n: number, l: number) => `무료 (${n}/${l})`,
      en: (n: number, l: number) => `Free (${n}/${l})`
    },
    until: {
      ko: (d: string) => `${d}까지`,
      en: (d: string) => `Until ${d}`
    },
    untilLong: {
      ko: (d: string) => `${d}까지 이용 가능`,
      en: (d: string) => `Access until ${d}`
    },
    subscribe: { ko: '프리미엄 구독하기', en: 'Subscribe to Premium' },
    restore: { ko: '구매 복원', en: 'Restore purchases' },
    restoring: { ko: '복원 중…', en: 'Restoring…' },
    manage: {
      ko: 'Play 스토어에서 구독 관리',
      en: 'Manage subscription in Play Store'
    },
    opening: { ko: '여는 중…', en: 'Opening…' },
    detailsTitle: { ko: '구독 정보', en: 'Subscription details' },
    signOut: { ko: '로그아웃', en: 'Sign out' },
    signingOut: { ko: '로그아웃 중…', en: 'Signing out…' },
    userFallback: { ko: '사용자', en: 'User' },
    close: { ko: '닫기', en: 'Close' }
  },
  paywall: {
    title: { ko: 'soundslime 프리미엄', en: 'soundslime Premium' },
    defaultReason: {
      ko: '무제한으로 슬라임을 즐겨보세요.',
      en: 'Enjoy soundslime without limits.'
    },
    limitReason: {
      ko: (limit: number, count: number) =>
        `오늘의 무료 사용(${limit}회, ${count}회 사용)을 모두 사용하셨어요. 프리미엄으로 무제한 이용해보세요.`,
      en: (limit: number, count: number) =>
        `You have used all ${limit} free sessions for today (${count} used). Go Premium for unlimited access.`
    },
    unsupported: {
      ko: '현재 플랫폼에서는 결제를 지원하지 않아요. 안드로이드 앱에서 다시 시도해주세요.',
      en: 'In-app purchases are not supported on this platform. Please try again from the Android app.'
    },
    monthly: { ko: '월간 구독', en: 'Monthly' },
    yearly: { ko: '연간 구독', en: 'Yearly' },
    savings: {
      ko: (pct: number) => `${pct}% 절약`,
      en: (pct: number) => `Save ${pct}%`
    },
    loading: { ko: '상품을 불러오는 중…', en: 'Loading plans…' },
    subscribeCta: { ko: '구독 시작하기', en: 'Start subscription' },
    purchasing: { ko: '결제 중…', en: 'Processing…' },
    restoreCta: { ko: '이미 구독했다면 복원', en: 'Already subscribed? Restore' },
    purchaseFailed: { ko: '결제에 실패했어요.', en: 'Purchase failed.' },
    restoreFailed: { ko: '복원에 실패했어요.', en: 'Restore failed.' },
    footer: {
      ko: 'Google Play를 통해 결제되며, 구독은 언제든 Play 스토어에서 해지할 수 있어요.',
      en: 'Billed through Google Play. Cancel anytime from your Play Store subscriptions.'
    },
    benefits: {
      ko: [
        '무제한 슬라임 만지기',
        '컬렉션 무제한 저장 · 기기 간 동기화',
        '슬라임멍 세션 확장 (기본 3분 → 최대 20분)',
        '광고 제거'
      ],
      en: [
        'Unlimited slime play',
        'Unlimited collections · sync across devices',
        'Extended slime-멍 sessions (3 min → up to 20 min)',
        'Ads removed'
      ]
    }
  }
} as const
