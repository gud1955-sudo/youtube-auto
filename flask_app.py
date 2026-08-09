import os
import threading
import uuid
from flask import Flask, render_template, request, jsonify, send_from_directory

from script_generator import (
    generate_setup,
    generate_intro_script,
    generate_chapter_script,
    generate_outro_script,
    generate_scene_prompts,
)
from gemini_image import generate_image, generate_thumbnail

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 32 * 1024 * 1024
app.config["TEMPLATES_AUTO_RELOAD"] = True

jobs = {}

TOTAL_STEPS = 14  # setup + thumbnail + intro + 10chapters + outro


def run_generation(job_id, story_title, reference_script):
    try:
        jobs[job_id]["total"] = TOTAL_STEPS

        # 1. 메타데이터 전체 생성
        jobs[job_id]["current_task"] = "제목 · 설명 · 등장인물 · 썸네일 프롬프트 생성 중..."
        setup = generate_setup(reference_script, story_title)
        jobs[job_id]["setup"] = setup
        jobs[job_id]["progress"] = 1

        # 2. 썸네일 이미지 생성
        jobs[job_id]["current_task"] = "썸네일 이미지 생성 중 (Gemini)..."
        try:
            generate_thumbnail(setup["thumbnail_prompt"])
            jobs[job_id]["thumbnail_url"] = "/images/thumbnail.png"
        except Exception as e:
            jobs[job_id]["thumbnail_url"] = None
            jobs[job_id]["thumbnail_error"] = str(e)
        jobs[job_id]["progress"] = 2

        # 3. 서론
        jobs[job_id]["current_task"] = "서론 작성 중..."
        intro = generate_intro_script(reference_script, story_title, setup["character_table"])
        jobs[job_id]["intro"] = intro
        jobs[job_id]["progress"] = 3

        # 4~13. 챕터 1~10
        chapters = []
        for i in range(1, 11):
            jobs[job_id]["current_task"] = f"챕터 {i} 대본 작성 중... ({i}/10)"
            script = generate_chapter_script(i, 10, reference_script, story_title, setup["character_table"])

            jobs[job_id]["current_task"] = f"챕터 {i} 장면 프롬프트 생성 중..."
            scene_prompts = generate_scene_prompts(i, script, setup["character_base_prompts"])

            scenes = []
            for si, prompt in enumerate(scene_prompts, start=1):
                jobs[job_id]["current_task"] = f"챕터 {i} 장면 {si}/{len(scene_prompts)} 이미지 생성 중 (Gemini)..."
                try:
                    generate_image(prompt, i, si)
                    img_url = f"/images/chapter_{i:02d}_scene_{si:02d}.png"
                except Exception:
                    img_url = None
                scenes.append({"prompt": prompt, "image_url": img_url})

            chapters.append({
                "chapter_num": i,
                "script":      script,
                "scenes":      scenes,
            })
            jobs[job_id]["chapters"] = chapters
            jobs[job_id]["progress"] = 3 + i

        # 14. 아웃트로
        jobs[job_id]["current_task"] = "아웃트로 작성 중..."
        outro = generate_outro_script(reference_script, story_title)
        jobs[job_id]["outro"] = outro
        jobs[job_id]["progress"] = TOTAL_STEPS
        jobs[job_id]["status"] = "done"
        jobs[job_id]["current_task"] = "완료!"

    except Exception as e:
        jobs[job_id]["error"] = str(e)
        jobs[job_id]["status"] = "error"


@app.route("/generate", methods=["POST"])
def generate():
    story_title      = request.form.get("story_title", "").strip()
    reference_script = request.form.get("reference_script", "").strip()

    if not story_title:
        return jsonify({"error": "영상 제목을 입력해주세요."}), 400

    job_id = str(uuid.uuid4())
    jobs[job_id] = {
        "status":       "running",
        "progress":     0,
        "total":        TOTAL_STEPS,
        "current_task": "시작 중...",
        "setup":        None,
        "thumbnail_url": None,
        "intro":        "",
        "chapters":     [],
        "outro":        "",
    }

    threading.Thread(
        target=run_generation,
        args=(job_id, story_title, reference_script),
        daemon=True,
    ).start()

    return jsonify({"job_id": job_id})


@app.route("/status/<job_id>")
def status(job_id):
    if job_id not in jobs:
        return jsonify({"error": "Job not found"}), 404
    return jsonify(jobs[job_id])


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/images/<filename>")
def serve_image(filename):
    return send_from_directory("output_images", filename)


if __name__ == "__main__":
    os.makedirs("output_images", exist_ok=True)
    app.run(debug=False, host="0.0.0.0", port=5000)
