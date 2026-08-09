import os
import sys
from datetime import datetime


def menu():
    print("\n" + "="*50)
    print("  유튜브 자동화 프로그램 - 시니어 콘텐츠")
    print("="*50)
    print("1. 대본 자동 생성 (Claude AI)")
    print("2. 기존 대본에서 프롬프트 추출")
    print("3. 유튜브 영상 업로드")
    print("4. 전체 워크플로우 확인")
    print("5. 장면별 Flow 프롬프트 + Vrew 가이드 생성  ← NEW")
    print("6. Flow 이미지 이름 정리 (scene_01.png 형식)")
    print("0. 종료")
    print("-"*50)
    return input("선택: ").strip()


def step_generate_script():
    from script_generator import generate_script, save_script

    print("\n[대본 생성]")
    print("1. 랜덤 주제로 생성")
    print("2. 직접 주제 입력")
    choice = input("선택: ").strip()

    if choice == "2":
        theme = input("주제를 입력하세요: ").strip()
        script = generate_script(theme=theme)
    else:
        script = generate_script()

    filename = save_script(script)

    print("\n[생성된 대본 요약]")
    print(f"제목: {script['title']}")
    print(f"챕터 수: {len(script['chapters'])}")

    show_prompts = input("\n프롬프트도 지금 확인할까요? (y/n): ").strip().lower()
    if show_prompts == "y":
        from prompt_extractor import extract_prompts, print_prompts, save_prompts
        prompts = extract_prompts(script)
        print_prompts(prompts)
        save_prompts(prompts)

    return script


def step_extract_prompts():
    from prompt_extractor import extract_prompts, print_prompts, save_prompts

    print("\n[프롬프트 추출]")
    script_files = []
    if os.path.exists("scripts"):
        script_files = sorted(os.listdir("scripts"), reverse=True)

    if script_files:
        print("저장된 대본 파일:")
        for i, f in enumerate(script_files[:5], 1):
            print(f"  {i}. {f}")
        print("  0. 직접 파일 경로 입력")

        choice = input("선택: ").strip()
        if choice == "0":
            filepath = input("파일 경로: ").strip()
        elif choice.isdigit() and 1 <= int(choice) <= len(script_files[:5]):
            filepath = os.path.join("scripts", script_files[int(choice) - 1])
        else:
            print("잘못된 선택입니다.")
            return
    else:
        filepath = input("대본 파일 경로를 입력하세요: ").strip()

    with open(filepath, "r", encoding="utf-8") as f:
        raw = f.read()

    from script_generator import parse_script
    script = parse_script(raw)
    prompts = extract_prompts(script)
    print_prompts(prompts)
    save_prompts(prompts)


def step_upload_youtube():
    from youtube_uploader import upload_video

    print("\n[유튜브 업로드]")

    video_path = input("영상 파일 경로: ").strip()
    title = input("영상 제목: ").strip()

    print("설명을 입력하세요 (빈 줄 두 번 입력 시 완료):")
    description_lines = []
    empty_count = 0
    while empty_count < 2:
        line = input()
        if line == "":
            empty_count += 1
        else:
            empty_count = 0
            description_lines.append(line)
    description = "\n".join(description_lines)

    print("\n공개 설정:")
    print("1. 비공개 (private) - 기본값")
    print("2. 일부공개 (unlisted)")
    print("3. 공개 (public)")
    privacy_choice = input("선택 (기본: 1): ").strip()
    privacy_map = {"1": "private", "2": "unlisted", "3": "public"}
    privacy = privacy_map.get(privacy_choice, "private")

    try:
        url = upload_video(video_path, title, description, privacy=privacy)
        print(f"\n🎉 업로드 성공: {url}")
    except FileNotFoundError as e:
        print(f"\n❌ 오류: {e}")


def show_workflow():
    print("""
╔══════════════════════════════════════════════════╗
║           콘텐츠 제작 워크플로우                    ║
╠══════════════════════════════════════════════════╣
║                                                  ║
║  [STEP 1] 이 프로그램                             ║
║    → Claude AI로 대본 자동 생성                   ║
║    → 힉스필드 영상 프롬프트 추출                   ║
║    → 챕터별 이미지 프롬프트 추출                   ║
║                                                  ║
║  [STEP 2] 수동 작업                               ║
║    → 힉스필드에서 후킹영상 제작                    ║
║    → AI 이미지 툴로 챕터별 이미지 생성             ║
║    → Vrew에서 대본 + 목소리 합성                  ║
║    → 캡컷에서 영상 + 이미지 + 음성 합치기          ║
║                                                  ║
║  [STEP 3] 이 프로그램                             ║
║    → 완성 영상 유튜브 자동 업로드                  ║
║                                                  ║
╚══════════════════════════════════════════════════╝
""")


def main():
    while True:
        choice = menu()

        if choice == "1":
            step_generate_script()
        elif choice == "2":
            step_extract_prompts()
        elif choice == "3":
            step_upload_youtube()
        elif choice == "4":
            show_workflow()
        elif choice == "5":
            from scene_pipeline import run_scene_pipeline
            run_scene_pipeline()
        elif choice == "6":
            from scene_pipeline import run_rename_images
            run_rename_images()
        elif choice == "0":
            print("종료합니다.")
            sys.exit(0)
        else:
            print("잘못된 선택입니다.")


if __name__ == "__main__":
    main()
