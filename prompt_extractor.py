def extract_prompts(script: dict) -> dict:
    prompts = {
        "higgsfield_prompt": script.get("hook_video_prompt", ""),
        "image_prompts": [],
    }

    for chapter in script.get("chapters", []):
        if chapter.get("image_prompt"):
            prompts["image_prompts"].append({
                "chapter": chapter.get("number", ""),
                "title": chapter.get("title", ""),
                "prompt": chapter.get("image_prompt", ""),
            })

    return prompts


def print_prompts(prompts: dict):
    print("\n" + "="*60)
    print("🎬 힉스필드 후킹영상 프롬프트")
    print("="*60)
    print(prompts["higgsfield_prompt"])

    print("\n" + "="*60)
    print("🖼️  챕터별 이미지 프롬프트")
    print("="*60)
    for item in prompts["image_prompts"]:
        print(f"\n[챕터 {item['chapter']}] {item['title']}")
        print(item["prompt"])


def save_prompts(prompts: dict, filename: str = None) -> str:
    import os
    from datetime import datetime

    os.makedirs("prompts", exist_ok=True)

    if not filename:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"prompts/prompts_{timestamp}.txt"

    with open(filename, "w", encoding="utf-8") as f:
        f.write("=== 힉스필드 후킹영상 프롬프트 ===\n\n")
        f.write(prompts["higgsfield_prompt"])
        f.write("\n\n=== 챕터별 이미지 프롬프트 ===\n\n")
        for item in prompts["image_prompts"]:
            f.write(f"[챕터 {item['chapter']}] {item['title']}\n")
            f.write(item["prompt"])
            f.write("\n\n")

    print(f"💾 프롬프트 저장됨: {filename}")
    return filename
