import anthropic
from config import ANTHROPIC_API_KEY

_BASE_RULES = """
[채널] 인생이야기 | [대상] 50~80대 시니어 | [스타일] 감동 드라마 나레이션

[창작 규칙]
- 참고 대본의 등장인물 성별·신분·직업·회사명·문장·대사를 모두 바꾸어 새로 창작
- 이야기 뼈대(사건 순서, 인물 관계, 감정선, 갈등·반전 구조)만 유지
- 챕터 구분: 헤더·번호 없이 빈 줄(줄바꿈)로만 구분
- 숫자: 순우리말 단위(달·살·명·번)는 한글 표기 ("세 달", "다섯 살") / 한자어 단위(년·층·원·%)는 아라비아 숫자
"""


def _client():
    return anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)


def generate_setup(reference_script: str, story_title: str) -> dict:
    """제목·설명·등장인물·썸네일·인물베이스프롬프트·인트로영상프롬프트 한 번에 생성"""
    prompt = f"""{_BASE_RULES}

참고 대본:
{reference_script[:4000]}

영상 제목(주제): {story_title}

위 참고 대본을 기반으로 아래 항목들을 순서대로 작성해주세요.
각 항목은 반드시 [항목명] 형식의 헤더로 구분합니다.

[제목5]
제목 5개 (번호 없이 줄바꿈으로 구분)
- 기계적 템플릿 반복 금지. 5개 모두 다른 방식으로 변주
- 인물의 처지·직업·상황을 구체적으로 넣고 결정적 장면이나 대사를 함께 제시
- 예시 패턴(참고만, 베끼지 말 것): "(대사 인용) + (신분/상황 수식) + (반전 암시 마무리 ...)"

[유튜브설명]
스포일러 없이 궁금증을 유지하는 2~3줄 줄거리 요약
(빈 줄)
#해시태그 5~7개

[등장인물]
주요 인물 2~3명 표 형식: 이름 | 나이·성별 | 외모·인상착의 상세 묘사
- 젊은 주인공(20~30대): 매력적이되 직업 사실적 디테일 포함 (기름때·굳은살·체형 등)
- 중장년(50대 이상): 주름·흰머리 등 나이 디테일 + 기품·관록 강조

[썸네일프롬프트]
영어, 포토리얼 (한국 드라마 스틸컷 스타일)
첫 문장: "A single continuous photorealistic frame, no borders, no seams, no dividing line, one unbroken photograph only."
- split·panel·divided·half·edge·boundary·diptych·collage 단어 절대 사용 금지
- 인물은 반드시 "East Asian Korean" 외모
- Composition: faces and main action framed within the upper two-thirds; bottom third kept visually simple with no faces, reserved for caption text overlay
- 감정(충격·눈물·놀람·절박함)이 분명히 드러날 것
- 텍스트·자막·배지 없음

[인물베이스프롬프트]
각 등장인물의 Flow AI 이미지 생성용 베이스 프롬프트 (영어, 서술형)
형식: @캐릭터이름: (묘사 문장 2~3개)
- 반드시 "East Asian Korean" 외모
- 나이·직업에 맞는 사실적 디테일 포함
- strikingly attractive / naturally attractive + age-appropriate 수식어 함께 사용

[인트로영상프롬프트]
서론에서 핵심 대사를 치는 장면 2~3컷 (Flow 영상용)
각 컷 형식:
컷 1: @캐릭터이름 / 행동·표정 / 대사 원문 / 카메라 워크 / 환경·조명 / 분위기 / 길이 3~5초
- 위 [인물베이스프롬프트]의 @이름 태그 그대로 사용
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
        "titles":                extract("제목5"),
        "youtube_meta":          extract("유튜브설명"),
        "character_table":       extract("등장인물"),
        "thumbnail_prompt":      extract("썸네일프롬프트"),
        "character_base_prompts": extract("인물베이스프롬프트"),
        "intro_video_prompts":   extract("인트로영상프롬프트"),
    }


def generate_intro_script(reference_script: str, story_title: str, character_table: str) -> str:
    prompt = f"""{_BASE_RULES}

참고 대본(뼈대 참고용):
{reference_script[:2000]}

등장인물:
{character_table}

영상 제목: {story_title}

서론(인트로)을 작성해주세요.

구조 (이 순서 그대로):
1. 이야기 후반부의 강렬한 대사 또는 반전 장면으로 바로 시작 (충격·궁금증 유발)
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


def generate_chapter_script(
    chapter_num: int,
    total_chapters: int,
    reference_script: str,
    story_title: str,
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

영상 제목: {story_title}

총 {total_chapters}챕터 중 {chapter_num}번째 챕터의 나레이션 대본을 작성해주세요.

규칙:
- 반드시 3,000~3,500자 사이로 작성 (글자 수 엄수)
- 챕터 제목·번호 없이 나레이션 본문만 출력
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


def generate_outro_script(reference_script: str, story_title: str) -> str:
    prompt = f"""{_BASE_RULES}

이야기 제목: {story_title}
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


def generate_chapter_image_prompt(
    chapter_num: int,
    chapter_script: str,
    character_base_prompts: str,
) -> str:
    prompt = f"""다음 챕터 대본을 바탕으로 Flow AI 이미지 생성용 영어 프롬프트를 작성하세요.

[고정 인물 베이스 프롬프트]
{character_base_prompts}

챕터 번호: {chapter_num}
챕터 내용 요약: {chapter_script[:500]}

규칙:
- 영어로만 작성, 서술형 한 문단 (5~7문장)
- 위 베이스 프롬프트의 @캐릭터이름 태그를 그대로 사용해 얼굴 일관성 유지
- "인물 행동 → 카메라 워크 → 공간·조명 → 분위기" 순서로 서술
- Photorealistic, cinematic, Korean drama style, East Asian 포함
- 텍스트·자막 없음
- 프롬프트만 출력
"""
    response = _client().messages.create(
        model="claude-sonnet-4-6",
        max_tokens=400,
        messages=[{"role": "user", "content": prompt}],
    )
    return response.content[0].text.strip()
