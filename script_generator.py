import anthropic
import base64
from config import ANTHROPIC_API_KEY

SYSTEM_PROMPT = """당신은 시니어(60대 이상) 유튜브 시청자를 위한 감동 드라마 대본 작가입니다.
제공된 콘티 전체를 참고하여 각 챕터당 정확히 2,000자의 나레이션 대본을 작성합니다.

규칙:
- 각 챕터는 반드시 1,900자 ~ 2,100자 사이로 작성 (글자 수 엄수)
- 나레이션 형식 (1인칭 또는 3인칭)
- 시니어가 공감할 수 있는 감정적이고 현실적인 문체
- 챕터 간 자연스러운 연결
- 각 챕터 끝에 다음 챕터에 대한 궁금증 유발
- 챕터 제목, 번호, 메타 정보 없이 나레이션 본문만 출력
"""


def _client():
    return anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)


def image_to_base64(image_bytes: bytes) -> str:
    return base64.standard_b64encode(image_bytes).decode("utf-8")


# ── 1단계: 콘티 생성 ────────────────────────────────────────
def generate_conti(story_title: str, chapter_count: int = 10) -> str:
    response = _client().messages.create(
        model="claude-sonnet-4-6",
        max_tokens=2000,
        messages=[{
            "role": "user",
            "content": f"""다음 영상 제목을 바탕으로 시니어 유튜브 드라마 콘티를 작성해주세요.

영상 제목: {story_title}
총 챕터 수: {chapter_count}챕터

아래 형식 그대로 출력하세요 (다른 말 없이):

[등장인물]
- 이름 (나이, 성별): 외모 특징 (얼굴, 머리, 체형, 주로 입는 옷 스타일을 구체적으로)
- (주요 인물 2~3명)

[챕터 구성]
챕터1 제목: (제목)
줄거리: (2~3줄로 해당 챕터에서 일어나는 일)

챕터2 제목: (제목)
줄거리: (2~3줄)

... ({chapter_count}챕터까지)"""
        }],
    )
    return response.content[0].text.strip()


def generate_thumbnail_prompt(story_title: str, conti_text: str) -> str:
    response = _client().messages.create(
        model="claude-sonnet-4-6",
        max_tokens=400,
        messages=[{
            "role": "user",
            "content": f"""다음 드라마 정보를 바탕으로 유튜브 썸네일 이미지 생성용 영어 프롬프트를 작성하세요.

제목: {story_title}
콘티:
{conti_text[:600]}

규칙:
- 영어로만 작성
- 한 문단 (4~5문장)
- 등장인물의 외모(콘티 참고)를 구체적으로 포함
- 드라마틱하고 감성적인 장면, 강렬한 감정 표현
- 인물은 반드시 "East Asian, Korean" 외모로 묘사
- "Photorealistic, cinematic, 8K, YouTube thumbnail style" 포함
- 프롬프트만 출력"""
        }],
    )
    return response.content[0].text.strip()


# ── 2단계: 캐릭터 프로필 추출 ────────────────────────────────
def generate_character_profile(conti_text: str) -> str:
    response = _client().messages.create(
        model="claude-sonnet-4-6",
        max_tokens=400,
        messages=[{
            "role": "user",
            "content": f"""다음 콘티의 등장인물 외모를 영어로 상세히 묘사하세요.
이미지 생성 AI에 고정으로 사용할 캐릭터 설명입니다.

콘티:
{conti_text}

규칙:
- 영어로만 작성
- 반드시 "East Asian, Korean" 외모로 묘사할 것
- 인물당 2~3문장: 나이대, 성별, 한국인 얼굴 특징, 머리카락, 체형, 옷 스타일
- 설명 없이 캐릭터 묘사만 출력"""
        }],
    )
    return response.content[0].text.strip()


# ── 2단계: 챕터 대본 생성 ────────────────────────────────────
def generate_chapter(
    chapter_num: int,
    total_chapters: int,
    conti_text: str,
    thumbnail_bytes: bytes = None,
) -> str:
    content = []

    if thumbnail_bytes and chapter_num == 1:
        content.append({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/jpeg",
                "data": image_to_base64(thumbnail_bytes),
            },
        })
        content.append({"type": "text", "text": "위 썸네일 이미지를 참고하여 아래 챕터 대본을 작성해주세요.\n\n"})

    content.append({"type": "text", "text": f"""전체 콘티:
{conti_text}

위 콘티를 바탕으로 전체 {total_chapters}챕터 중 {chapter_num}번째 챕터의 나레이션 대본을 작성해주세요.

【중요】 반드시 1,900자 ~ 2,100자 사이로 작성하세요. 공백 포함 글자 수를 직접 세어가며 작성하세요.
챕터 제목, 번호 없이 나레이션 본문만 출력하세요."""})

    messages = [{"role": "user", "content": content}]

    response = _client().messages.create(
        model="claude-sonnet-4-6",
        max_tokens=3000,
        system=SYSTEM_PROMPT,
        messages=messages,
    )
    script = response.content[0].text

    if len(script) < 1800:
        messages.append({"role": "assistant", "content": script})
        messages.append({
            "role": "user",
            "content": f"현재 {len(script)}자입니다. 2,000자가 되도록 이야기를 자연스럽게 이어서 더 작성해주세요. 앞 내용을 반복하지 말고 이어지는 내용만 출력하세요."
        })
        continuation = _client().messages.create(
            model="claude-sonnet-4-6",
            max_tokens=1500,
            system=SYSTEM_PROMPT,
            messages=messages,
        )
        script = script + continuation.content[0].text

    return script


# ── 2단계: 이미지 프롬프트 생성 ──────────────────────────────
def generate_image_prompt(chapter_num: int, chapter_content: str, character_profile: str) -> str:
    response = _client().messages.create(
        model="claude-sonnet-4-6",
        max_tokens=400,
        messages=[{
            "role": "user",
            "content": f"""다음 챕터 내용을 바탕으로 Gemini 이미지 생성용 영어 프롬프트를 작성하세요.

[고정 캐릭터 설명 - 반드시 포함]
{character_profile}

챕터 번호: {chapter_num}챕터
챕터 내용 요약: {chapter_content[:300]}

규칙:
- 영어로만 작성, 한 문단 (4~5문장)
- 위 캐릭터 설명을 그대로 포함하여 인물 외모가 매 챕터 동일하게 유지
- 인물은 반드시 "East Asian, Korean" 외모로 묘사
- 한국 시니어 배경의 감성적인 장면
- "Photorealistic, cinematic, emotional, 8K" 포함
- 프롬프트만 출력"""
        }],
    )
    return response.content[0].text.strip()


# ── 유튜브 메타데이터 ─────────────────────────────────────────
def generate_youtube_meta(story_title: str, conti_text: str) -> dict:
    response = _client().messages.create(
        model="claude-sonnet-4-6",
        max_tokens=500,
        messages=[{
            "role": "user",
            "content": f"""다음 영상 정보를 바탕으로 유튜브 메타데이터를 작성해주세요.

제목: {story_title}
콘티:
{conti_text}

아래 형식으로만 출력하세요:

[유튜브제목]
(클릭을 유발하는 강렬한 제목)

[유튜브설명]
(3~5줄 설명, 해시태그 포함)

[태그]
(쉼표로 구분된 태그 10개)"""
        }],
    )
    return {"raw": response.content[0].text}
