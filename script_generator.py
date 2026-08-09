import anthropic
from config import ANTHROPIC_API_KEY

# ── 기본 창작 규칙 ──────────────────────────────────────────────
_BASE_RULES = """
[채널] 인생이야기 | [대상] 50~80대 시니어 | [스타일] 감동 드라마 나레이션

[창작 규칙]
- 참고 대본의 등장인물 성별·신분·직업·회사명·문장·대사를 모두 바꾸어 새로 창작
- 이야기 뼈대(사건 순서, 인물 관계, 감정선, 갈등·반전 구조)만 유지
- 직업을 바꿀 때 성별 고정관념이 심한 직업은 피하거나 다른 직업으로 교체; 그 직업이 담당한 핵심 플롯 장치는 자연스러운 서사적 다리를 만들어 반드시 살린다
- 챕터 구분: 헤더·번호 없이 빈 줄(줄바꿈)로만 구분 (Vrew TTS 호환)
- 숫자: 순우리말 단위(달·살·명·번)는 한글 표기("세 달","다섯 살") / 한자어 단위(년·층·원·%)는 아라비아 숫자

[핵심 통일 원칙]
썸네일 = 인트로 영상 = 대본 맨 첫 줄/첫 장면 = 1번 대표 제목 → 전부 같은 하나의 순간을 가리켜야 한다.
"""

# ── Flow 이미지 프롬프트 공통 안전 규칙 ────────────────────────
_FLOW_SAFETY = """
[Flow 프롬프트 필수 안전 규칙]
- 첫 문장: "A single continuous photorealistic frame, no borders, no seams, no dividing line, one unbroken photograph only."
- split·panel·divided·half·edge·boundary·diptych·collage 단어 절대 사용 금지
- 두 인물/장면 함께 담을 때: foreground/background, in focus/softly out of focus, gradient of lighting 표현만 사용
- 텍스트·자막·워터마크·시간배지 없음
- 얼굴은 항상 stunningly beautiful / model-like symmetrical features / large clear expressive eyes / flawless radiant skin
- 직업·나이 디테일은 얼굴이 아닌 손(faint calloused fingertips)·복장·자세·소품에만
- 프롬프트 끝: "Avoid any dull, tired, or unattractive rendering."
- 아동 묘사 시: 나이+성별 구체적 결합 금지 → "a young child" / "a small child"로 표현
  사진 속 아이는 흐릿하게 ("a blurry keepsake photo, edges worn and yellowed with age")
  비교/대조 뉘앙스 대신 단일 행동으로 단순화 ("가만히 바라본다")
"""


def _client():
    return anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)


# ── 1. 메타데이터 전체 생성 ─────────────────────────────────────
def generate_setup(reference_script: str) -> dict:
    """제목5·설명·등장인물·썸네일·인물베이스·인트로영상 한 번에 생성"""
    prompt = f"""{_BASE_RULES}

참고 대본:
{reference_script[:4000]}

위 참고 대본을 기반으로 아래 항목들을 순서대로 작성해주세요.
각 항목은 반드시 [항목명] 형식 헤더로 구분합니다.

[제목5]
제목 5개 (번호 없이 줄바꿈으로 구분)

규칙:
- 짧고 강하게 끊어 친다. ?, !, ... 적극 사용. 긴 서술형 문장 금지.
- 1번 제목: 반드시 대본 맨 첫 장면(서론 첫 줄)과 동일한 순간을 가리키고, 끝에 "(★ 업로드용 대표 제목)" 표시
- 2~5번: 다른 후킹 포인트를 보여주는 참고용 대안
- 기계적 템플릿("정체는 '이 사람'이었습니다") 반복 금지. 매번 다른 방식으로 변주.

강한 제목 예시(패턴만 참고, 그대로 베끼지 말 것):
"쉿! 도청장치가 있어요" 청소부가 건넨 쪽지를 본 재벌회장은 다음날...
"어! 우리 엄마꺼?!" 국밥집 직원 6살 아들이 백만장자의 시계를 보고
한겨울 저수지에 버려진 치매 걸린 엄마, 아들차가 떠나자 보따리에서 꺼낸 아이는...?

구성 요령: (짧고 강한 대사 인용 또는 충격 상황) + (신분/상황 압축) + ("...", "?!", "!" 등 반전 암시 마무리)

[유튜브설명]
스포일러 없이 궁금증을 유지하는 2~3줄 줄거리 요약
(빈 줄)
#해시태그 5~7개

[등장인물]
주요 인물 2~3명 표 형식: 이름 | 나이·성별 | 외모·인상착의 상세 묘사
- 얼굴: 항상 배우·모델급으로 아름답고 매력적으로 묘사 (가난·고생 등 처지를 얼굴에 반영하지 말 것)
- 직업·나이 디테일: 얼굴이 아닌 손·복장·자세·소품에만 표현
- 중장년 이상: 흰머리·눈가 주름 정도의 자연스러운 수준, 검버섯/처짐 표현 금지

[썸네일프롬프트]
{_FLOW_SAFETY}
- 반드시 대본 맨 첫 장면(서론 첫 줄)과 동일한 순간으로 구성
- 포토리얼 한국 드라마 스틸컷 스타일 (일러스트/페인팅 금지)
- Composition: faces and main action framed within upper two-thirds; bottom third kept visually simple with no faces, reserved for caption text overlay
- 감정(충격·눈물·놀람·절박함)이 분명히 드러날 것
- 인물은 반드시 "East Asian Korean" 외모

[인물베이스프롬프트]
각 등장인물의 Flow Nano Banana용 베이스 프롬프트 (영어, 서술형)
형식: @캐릭터이름: (묘사 문장 3~4개)
- 얼굴: stunningly beautiful / model-like symmetrical features / large clear expressive eyes / flawless radiant skin 중심
- 직업·나이 디테일: faint calloused fingertips / worn cardigan / slightly stooped posture 등 얼굴 외 요소에만
- 끝에: "Avoid any dull, tired, or unattractive rendering."
- 아동 등장 시 "Flow 이미지 안전 규칙" 적용

[인트로영상프롬프트]
썸네일(=대본 첫 장면)과 완전히 동일한 장면 하나가 움직이며 대사를 치는 단일 컷 (복수 컷 금지)
순서: 카메라 워크 → 인물 행동 → 대사(큰따옴표, 립싱크용 — 대본 첫 줄 실제 대사와 동일) → 환경·조명 → 분위기 → 길이 4~5초
- 지시는 간결하게 (Flow Veo 3.1은 지시 많으면 일부 누락)
- "same wardrobe/framing/lighting as the main thumbnail" 명시
- 위 [인물베이스프롬프트]의 @이름 태그 그대로 사용
- Flow 팁: 썸네일 이미지를 먼저 만들고 그 이미지를 "Image to Video"에 함께 넣으면 더 정확히 이어짐
"""

    response = _client().messages.create(
        model="claude-sonnet-4-6",
        max_tokens=4096,
        messages=[{"role": "user", "content": prompt}],
    )
    raw = response.content[0].text

    tags = ["제목5", "유튜브설명", "등장인물", "썸네일프롬프트", "인물베이스프롬프트", "인트로영상프롬프트"]

    def extract(tag):
        start = raw.find(f"[{tag}]")
        if start == -1:
            return ""
        start = raw.find("\n", start) + 1
        end = len(raw)
        for t in tags:
            pos = raw.find(f"[{t}]", start)
            if pos != -1 and pos < end:
                end = pos
        return raw[start:end].strip()

    return {
        "titles":                 extract("제목5"),
        "youtube_meta":           extract("유튜브설명"),
        "character_table":        extract("등장인물"),
        "thumbnail_prompt":       extract("썸네일프롬프트"),
        "character_base_prompts": extract("인물베이스프롬프트"),
        "intro_video_prompts":    extract("인트로영상프롬프트"),
    }


# ── 2. 서론 생성 ────────────────────────────────────────────────
def generate_intro_script(reference_script: str, character_table: str) -> str:
    prompt = f"""{_BASE_RULES}

참고 대본(뼈대 참고용):
{reference_script[:2000]}

등장인물:
{character_table}

서론(인트로)을 작성해주세요.

핵심 원칙:
- 맨 첫 줄/첫 장면이 썸네일·인트로영상·1번 대표 제목과 완전히 동일한 순간이 되도록 설계
- 첫 줄은 반드시 인물의 강렬한 대사 또는 반전 장면으로 바로 시작 (내레이션 설명 금지)

구조 (이 순서 그대로):
1. 강렬한 대사 또는 반전 장면으로 바로 시작 (충격·궁금증 유발, 인용부호 사용)
2. 핵심 갈등을 궁금하게 만드는 짧은 요약 내레이션
3. 고정 멘트 (그대로): "이야기 시작 전 구독과 좋아요 눌러 주시고, 지금 계신 곳을 댓글로 남겨 주세요. 그 댓글 하나하나에 행운 가득한 하루를 실어 보내 드리겠습니다."
4. "인생이야기, 오늘의 이야기를 시작합니다."

규칙: 헤더·번호 없이 본문만 출력 / 분량 500~800자
"""
    response = _client().messages.create(
        model="claude-sonnet-4-6",
        max_tokens=1200,
        messages=[{"role": "user", "content": prompt}],
    )
    return response.content[0].text.strip()


# ── 3. 챕터 대본 생성 ───────────────────────────────────────────
def generate_chapter_script(
    chapter_num: int,
    total_chapters: int,
    reference_script: str,
    character_table: str,
) -> str:
    is_last = (chapter_num == total_chapters)
    continuation_note = (
        "마지막 챕터입니다. 이야기를 완전히 마무리하세요."
        if is_last else
        f"{chapter_num + 1}챕터로 자연스럽게 이어지며 궁금증을 유발하세요."
    )

    prompt = f"""{_BASE_RULES}

참고 대본(전체 뼈대):
{reference_script[:5000]}

등장인물:
{character_table}

총 {total_chapters}챕터 중 {chapter_num}번째 챕터의 나레이션 대본을 작성해주세요.

규칙:
- 반드시 3,000~3,500자 사이로 작성 (글자 수 엄수)
- 챕터 제목·번호 없이 나레이션 본문만 출력
- 챕터 안에 장면 전환이 자연스럽게 3~4번 일어나도록 구성 (장소·시간·상황이 바뀔 때 빈 줄 하나로 구분)
- 시니어가 공감하는 감성적·현실적 문체
- {continuation_note}
"""

    messages = [{"role": "user", "content": prompt}]
    response = _client().messages.create(
        model="claude-sonnet-4-6",
        max_tokens=5000,
        messages=messages,
    )
    script = response.content[0].text.strip()

    if len(script) < 2800:
        messages.append({"role": "assistant", "content": script})
        messages.append({
            "role": "user",
            "content": f"현재 {len(script)}자입니다. 3,000자가 되도록 앞 내용 반복 없이 자연스럽게 이어지는 내용만 추가해주세요.",
        })
        cont = _client().messages.create(
            model="claude-sonnet-4-6",
            max_tokens=2000,
            messages=messages,
        )
        script = script + "\n\n" + cont.content[0].text.strip()

    return script


# ── 4. 아웃트로 생성 ────────────────────────────────────────────
def generate_outro_script(reference_script: str) -> str:
    prompt = f"""{_BASE_RULES}

참고 대본 마지막 부분:
{reference_script[-1500:] if len(reference_script) > 1500 else reference_script}

아웃트로(마무리) 멘트를 작성해주세요.

구조 (이 순서 그대로):
1. 오늘 이야기의 여운을 담은 짧은 멘트 (2~3문장)
2. 채널 소개 및 구독·좋아요 독려 멘트
3. 사연 속 인물을 향한 댓글 유도 멘트
4. "지금까지 인생이야기였습니다. 감사합니다."

규칙: 헤더·번호 없이 본문만 출력 / 분량 200~400자
"""
    response = _client().messages.create(
        model="claude-sonnet-4-6",
        max_tokens=600,
        messages=[{"role": "user", "content": prompt}],
    )
    return response.content[0].text.strip()


# ── 5. 장면별 이미지 프롬프트 생성 ─────────────────────────────
def generate_scene_prompts(
    chapter_num: int,
    chapter_script: str,
    character_base_prompts: str,
    photo_start_num: int = 1,
) -> list:
    """챕터 대본을 장면별로 분석해 Flow Nano Banana/Imagen용 프롬프트 3~4개 생성.
    photo_start_num: 이 챕터의 첫 사진 전체 일련번호"""
    prompt = f"""다음 챕터 대본을 장면별로 분석하여 Flow 이미지 생성용 영어 프롬프트를 작성하세요.

[고정 인물 베이스 프롬프트]
{character_base_prompts}

챕터 {chapter_num} 대본:
{chapter_script}

{_FLOW_SAFETY}

추가 규칙:
- 대본에서 장소·시간·상황이 바뀌는 지점 기준으로 3~4개 장면으로 나눔
- 각 장면마다 프롬프트 1개 (5~6문장, 서술형)
- 위 베이스 프롬프트의 @캐릭터이름 태그 그대로 사용
- "인물 행동·표정 → 카메라 워크 → 공간·조명 → 분위기" 순서
- Photorealistic, cinematic, Korean drama still, East Asian 포함
- 각 프롬프트 앞에 반드시 전체 일련번호 붙이기 (예: 이 챕터 첫 사진이 사진 {photo_start_num}번이면 → [사진{photo_start_num}], [사진{photo_start_num+1}] 순서)

출력 형식 (이 형식만 사용, 다른 설명 없이):
[사진{photo_start_num}]
(프롬프트 영어 문장)

[사진{photo_start_num+1}]
(프롬프트 영어 문장)

[사진{photo_start_num+2}]
(프롬프트 영어 문장)

[사진{photo_start_num+3}] (있을 경우만)
(프롬프트 영어 문장)
"""
    response = _client().messages.create(
        model="claude-sonnet-4-6",
        max_tokens=1800,
        messages=[{"role": "user", "content": prompt}],
    )
    raw = response.content[0].text

    scenes = []
    n = photo_start_num
    while True:
        tag = f"[사진{n}]"
        start = raw.find(tag)
        if start == -1:
            break
        start = raw.find("\n", start) + 1
        end = raw.find(f"[사진{n+1}]")
        if end == -1:
            end = len(raw)
        text = raw[start:end].strip()
        if text:
            scenes.append({"photo_num": n, "prompt": text})
        n += 1

    return scenes if scenes else [{"photo_num": photo_start_num, "prompt": raw.strip()}]


# ── 6. 삽입 위치 안내 (Vrew 검색 키) 생성 ──────────────────────
def generate_insertion_guide(chapter_num: int, chapter_script: str, scenes: list) -> list:
    """각 사진에 대한 Vrew 검색 키 문장 생성"""
    photo_list = "\n".join([f"사진{s['photo_num']}" for s in scenes])
    prompt = f"""아래 챕터 대본에서 각 사진이 삽입될 위치를 나타내는 '검색 키' 문장을 찾아주세요.

챕터 {chapter_num} 대본:
{chapter_script}

찾아야 할 사진 목록:
{photo_list}

규칙:
- 각 사진마다 대본 본문에서 **딱 한 번만 등장하는** 실제 문장(또는 문장 일부)을 골라야 함
- 새로 만들어 끼워넣지 않는다. 반드시 대본에 실제로 있는 문장 그대로
- 해당 문장이 나오는 문단 앞·뒤에 이미지를 삽입하면 됨
- 각 사진의 장면 상황을 간략히 설명 (10자 이내)

출력 형식 (이 형식만, 다른 설명 없이):
사진{scenes[0]['photo_num']} — (장면 상황): "(검색 키 문장)"
사진{scenes[1]['photo_num'] if len(scenes)>1 else '?'} — (장면 상황): "(검색 키 문장)"
(이하 동일)
"""
    response = _client().messages.create(
        model="claude-sonnet-4-6",
        max_tokens=600,
        messages=[{"role": "user", "content": prompt}],
    )
    lines = [l.strip() for l in response.content[0].text.strip().split("\n") if l.strip()]
    return lines
