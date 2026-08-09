"""
대본 → 장면 분석 → Flow 프롬프트 + Vrew 검색키 자동 생성
"""

import json
import os
from pathlib import Path
from datetime import datetime
import anthropic
from config import ANTHROPIC_API_KEY


SCENE_ANALYSIS_PROMPT = """\
다음 대본을 읽고, 시각적으로 장면이 바뀌는 지점마다 이미지 삽입 정보를 생성하라.

[등장인물 외모 고정 설정]
{character_profile}

[대본 전문]
{script_text}

출력 규칙:
- 아래 JSON 형식 외에 어떤 말도 하지 마라
- 코드블록(```) 없이 JSON만 출력

{{
  "scenes": [
    {{
      "no": 1,
      "situation": "한 줄 상황 설명 (한국어)",
      "search_key": "대본 본문에 딱 한 번만 등장하는 실제 문장 그대로 (새로 만들지 말 것)",
      "flow_prompt": "영어 Flow 이미지 프롬프트"
    }}
  ]
}}

Flow 프롬프트 필수 규칙:
1. 첫 문장 고정: A single continuous photorealistic frame, no borders, no seams, no dividing line, one unbroken photograph only.
2. 서술형 문장으로만 작성. 콤마 키워드 나열 금지.
3. 순서: 인물 행동/표정 → 카메라 워크 → 공간·조명 → 분위기
4. 절대 사용 금지 단어: split, panel, divided, half, edge, boundary, diptych, collage
5. 인물 묘사는 위 [등장인물 외모 고정 설정] 그대로 사용 (East Asian, Korean 포함)
6. 마지막 문장 고정: Photorealistic Korean drama still, cinematic lighting, emotionally resonant.

장면 분리 기준 (아래 중 하나라도 해당하면 새 장면):
- 시간 이동 (다음 날, 몇 주 후, 그로부터 등)
- 장소 이동
- 등장 인물 교체 또는 주요 인물 등장
- 감정 또는 분위기의 큰 전환
- 중요한 사건 발생

장면 수: 전체 대본 기준 15~25개 목표. 너무 많거나 적지 않게.\
"""

EXTRACT_CHARACTER_PROMPT = """\
다음 대본에서 등장인물의 외모 설명을 추출하거나, 없으면 대본 내용을 바탕으로 추론해서 작성하라.
Flow 이미지 생성에 사용할 캐릭터 고정 설명이다.

[대본]
{script_text}

출력 규칙:
- 영어로만 작성
- 인물당 2~3문장: 나이대, 성별, Korean 얼굴 특징, 헤어, 체형, 의상 스타일
- 반드시 "East Asian, Korean" 포함
- 설명 없이 캐릭터 묘사만 출력\
"""


def _client():
    return anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)


def extract_character_profile(script_text: str) -> str:
    """대본에서 캐릭터 외모 프로필 추출"""
    print("  캐릭터 프로필 추출 중...")
    response = _client().messages.create(
        model="claude-sonnet-4-6",
        max_tokens=600,
        messages=[{
            "role": "user",
            "content": EXTRACT_CHARACTER_PROMPT.format(script_text=script_text[:3000])
        }],
    )
    return response.content[0].text.strip()


def analyze_scenes(script_text: str, character_profile: str) -> list[dict]:
    """대본을 장면별로 분석해서 Flow 프롬프트 + Vrew 검색키 생성"""
    print("  장면 분석 중... (대본이 길면 1~2분 걸릴 수 있어요)")

    response = _client().messages.create(
        model="claude-sonnet-4-6",
        max_tokens=10000,
        messages=[{
            "role": "user",
            "content": SCENE_ANALYSIS_PROMPT.format(
                character_profile=character_profile,
                script_text=script_text,
            )
        }],
    )

    raw = response.content[0].text.strip()
    if raw.startswith("```"):
        parts = raw.split("```")
        raw = parts[1]
        if raw.startswith("json"):
            raw = raw[4:].strip()

    data = json.loads(raw)
    return data["scenes"]


def save_production_package(scenes: list[dict], project_name: str, script_text: str) -> str:
    """Flow 프롬프트 파일 + Vrew 가이드 파일 + 대본 파일 저장"""
    timestamp = datetime.now().strftime("%Y%m%d_%H%M")
    safe_name = project_name.replace(" ", "_").replace("/", "_")
    output_dir = Path("output") / f"{safe_name}_{timestamp}"
    output_dir.mkdir(parents=True, exist_ok=True)

    # 1. Flow 프롬프트 (복붙용)
    flow_path = output_dir / "flow_prompts.txt"
    with open(flow_path, "w", encoding="utf-8") as f:
        f.write(f"[{project_name}] Google Flow 이미지 프롬프트\n")
        f.write(f"총 {len(scenes)}개 장면\n")
        f.write("=" * 60 + "\n\n")
        for scene in scenes:
            f.write(f"■ 장면 {scene['no']:02d}  —  {scene['situation']}\n")
            f.write("-" * 40 + "\n")
            f.write(f"{scene['flow_prompt']}\n\n\n")

    # 2. Vrew 삽입 가이드
    vrew_path = output_dir / "vrew_guide.txt"
    with open(vrew_path, "w", encoding="utf-8") as f:
        f.write(f"[{project_name}] Vrew 이미지 삽입 가이드\n")
        f.write("Vrew에서 Ctrl+F → 검색키 입력 → 해당 위치에 이미지 삽입\n")
        f.write("=" * 60 + "\n\n")
        for scene in scenes:
            f.write(f"scene_{scene['no']:02d}.png\n")
            f.write(f"  상황: {scene['situation']}\n")
            f.write(f"  Ctrl+F 검색: \"{scene['search_key']}\"\n\n")

    # 3. 대본
    script_path = output_dir / "script.txt"
    script_path.write_text(script_text, encoding="utf-8")

    # 4. 작업 순서 안내
    readme_path = output_dir / "작업순서.txt"
    with open(readme_path, "w", encoding="utf-8") as f:
        f.write(f"프로젝트: {project_name}\n")
        f.write(f"생성: {timestamp}\n")
        f.write(f"총 장면: {len(scenes)}개\n\n")
        f.write("─ 작업 순서 ─────────────────────────────────\n\n")
        f.write("1. flow_prompts.txt 열기\n")
        f.write("2. 장면 01부터 순서대로 Google Flow에 프롬프트 붙여넣기\n")
        f.write("3. 생성된 이미지 다운로드 (이 폴더에 저장)\n")
        f.write("4. 이 프로그램 메뉴 5 → '이미지 이름 정리' 실행\n")
        f.write("   → scene_01.png, scene_02.png... 자동 변환\n")
        f.write("5. Vrew 열고 script.txt 불러오기\n")
        f.write("6. vrew_guide.txt 보면서 Ctrl+F로 위치 찾고 이미지 삽입\n\n")
        f.write("─ 장면 목록 ──────────────────────────────────\n\n")
        for scene in scenes:
            f.write(f"  scene_{scene['no']:02d}: {scene['situation']}\n")

    print(f"\n저장 완료: {output_dir.resolve()}")
    return str(output_dir.resolve())


def rename_downloaded_images(images_dir: str) -> int:
    """Flow에서 다운받은 이미지를 scene_01.png 형식으로 일괄 이름 변경"""
    img_dir = Path(images_dir)
    if not img_dir.exists():
        print(f"폴더를 찾을 수 없습니다: {images_dir}")
        return 0

    images = sorted([
        f for f in img_dir.iterdir()
        if f.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp")
        and not f.stem.startswith("scene_")
    ])

    if not images:
        print("이름 변경할 이미지가 없습니다. (scene_으로 시작하는 파일은 건너뜀)")
        return 0

    print(f"\n발견된 이미지: {len(images)}개")
    print("미리보기:")
    for i, img in enumerate(images[:5], 1):
        print(f"  {img.name} → scene_{i:02d}{img.suffix}")
    if len(images) > 5:
        print(f"  ... 외 {len(images)-5}개")

    confirm = input("\n이대로 이름을 변경할까요? (y/n): ").strip().lower()
    if confirm != "y":
        print("취소됐습니다.")
        return 0

    for i, img in enumerate(images, 1):
        new_name = img.parent / f"scene_{i:02d}{img.suffix}"
        img.rename(new_name)

    print(f"완료: {len(images)}개 파일 이름 변경")
    return len(images)


def run_scene_pipeline():
    """메인 대화형 실행"""
    print("\n[장면별 이미지 파이프라인]")
    print("대본 파일을 읽어서 Flow 프롬프트와 Vrew 가이드를 자동 생성합니다.\n")

    # 대본 파일 선택
    script_files = []
    scripts_dir = Path("scripts")
    if scripts_dir.exists():
        script_files = sorted(scripts_dir.glob("*.txt"), reverse=True)

    if script_files:
        print("저장된 대본 파일:")
        for i, f in enumerate(script_files[:5], 1):
            print(f"  {i}. {f.name}")
        print("  0. 직접 경로 입력")
        choice = input("선택: ").strip()

        if choice == "0":
            script_path = input("대본 파일 경로: ").strip()
        elif choice.isdigit() and 1 <= int(choice) <= len(script_files[:5]):
            script_path = str(script_files[int(choice) - 1])
        else:
            print("잘못된 선택.")
            return
    else:
        script_path = input("대본 파일 경로를 입력하세요: ").strip()

    if not os.path.exists(script_path):
        print(f"파일을 찾을 수 없습니다: {script_path}")
        return

    with open(script_path, "r", encoding="utf-8") as f:
        script_text = f.read()

    print(f"\n대본 읽기 완료: {len(script_text):,}자")

    # 프로젝트 이름
    project_name = input("프로젝트 이름 (예: 운전기사_강하은): ").strip()
    if not project_name:
        project_name = Path(script_path).stem

    # 캐릭터 프로필
    print("\n캐릭터 프로필 입력 방법:")
    print("  1. 자동 추출 (Claude가 대본에서 추출)")
    print("  2. 직접 입력")
    profile_choice = input("선택 (기본: 1): ").strip() or "1"

    if profile_choice == "2":
        print("캐릭터 프로필을 영어로 입력하세요 (빈 줄 두 번 입력 시 완료):")
        lines = []
        empty = 0
        while empty < 2:
            line = input()
            if line == "":
                empty += 1
            else:
                empty = 0
                lines.append(line)
        character_profile = "\n".join(lines)
    else:
        character_profile = extract_character_profile(script_text)
        print(f"\n추출된 프로필:\n{character_profile}\n")

    # 장면 분석 실행
    print("\n분석 시작...")
    try:
        scenes = analyze_scenes(script_text, character_profile)
    except json.JSONDecodeError as e:
        print(f"JSON 파싱 오류: {e}")
        print("Claude 응답을 파싱하지 못했습니다. 다시 시도해 주세요.")
        return

    print(f"\n총 {len(scenes)}개 장면 분석 완료")
    print("\n장면 목록:")
    for scene in scenes:
        print(f"  {scene['no']:02d}. {scene['situation']}")

    # 저장
    save_production_package(scenes, project_name, script_text)


def run_rename_images():
    """이미지 이름 정리 실행"""
    print("\n[이미지 이름 정리]")
    print("Flow에서 다운받은 이미지를 scene_01.png 형식으로 변환합니다.\n")

    output_dirs = []
    output_base = Path("output")
    if output_base.exists():
        output_dirs = sorted(output_base.iterdir(), reverse=True)
        output_dirs = [d for d in output_dirs if d.is_dir()]

    if output_dirs:
        print("최근 출력 폴더:")
        for i, d in enumerate(output_dirs[:5], 1):
            print(f"  {i}. {d.name}")
        print("  0. 직접 경로 입력")
        choice = input("이미지가 있는 폴더 선택: ").strip()

        if choice == "0":
            images_dir = input("폴더 경로: ").strip()
        elif choice.isdigit() and 1 <= int(choice) <= len(output_dirs[:5]):
            images_dir = str(output_dirs[int(choice) - 1])
        else:
            print("잘못된 선택.")
            return
    else:
        images_dir = input("이미지 폴더 경로를 입력하세요: ").strip()

    rename_downloaded_images(images_dir)
