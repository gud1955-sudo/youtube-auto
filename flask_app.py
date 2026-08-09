import os
import threading
import uuid
from flask import Flask, render_template, request, jsonify, send_from_directory

from script_generator import (
    generate_conti, generate_thumbnail_prompt,
    generate_chapter, generate_image_prompt,
    generate_character_profile, generate_youtube_meta,
)
from gemini_image import generate_image, generate_thumbnail

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024 * 1024
app.config["TEMPLATES_AUTO_RELOAD"] = True

jobs = {}


# ── 1단계: 콘티 + 썸네일 생성 ──────────────────────────────
def run_conti_generation(job_id, story_title, chapter_count):
    try:
        jobs[job_id]["current_task"] = "콘티 작성 중..."
        conti_text = generate_conti(story_title, chapter_count)
        jobs[job_id]["conti_text"] = conti_text

        jobs[job_id]["current_task"] = "썸네일 프롬프트 생성 중..."
        thumb_prompt = generate_thumbnail_prompt(story_title, conti_text)

        jobs[job_id]["current_task"] = "썸네일 이미지 생성 중 (Gemini)..."
        try:
            generate_thumbnail(thumb_prompt)
            jobs[job_id]["thumbnail_url"] = "/images/thumbnail.png"
        except Exception as e:
            jobs[job_id]["thumbnail_url"] = None
            jobs[job_id]["thumbnail_error"] = str(e)

        jobs[job_id]["status"] = "done"

    except Exception as e:
        jobs[job_id]["error"] = str(e)
        jobs[job_id]["status"] = "error"


@app.route("/generate-conti", methods=["POST"])
def generate_conti_route():
    story_title   = request.form.get("story_title", "").strip()
    chapter_count = int(request.form.get("chapter_count", 10))

    if not story_title:
        return jsonify({"error": "영상 제목을 입력해주세요."}), 400

    job_id = str(uuid.uuid4())
    jobs[job_id] = {
        "status": "running",
        "current_task": "시작 중...",
        "conti_text": "",
        "thumbnail_url": None,
    }

    threading.Thread(
        target=run_conti_generation,
        args=(job_id, story_title, chapter_count),
        daemon=True,
    ).start()

    return jsonify({"job_id": job_id})


# ── 2단계: 대본 + 챕터 이미지 생성 ────────────────────────
def run_generation(job_id, story_title, chapter_count, conti_text):
    jobs[job_id]["status"] = "running"
    jobs[job_id]["results"] = []

    jobs[job_id]["current_task"] = "캐릭터 분석 중..."
    character_profile = generate_character_profile(conti_text)

    for i in range(1, chapter_count + 1):
        try:
            jobs[job_id]["progress"] = i - 1
            jobs[job_id]["current_task"] = f"챕터 {i} 대본 생성 중... ({i}/{chapter_count})"

            script = generate_chapter(
                chapter_num=i,
                total_chapters=chapter_count,
                conti_text=conti_text,
            )

            jobs[job_id]["current_task"] = f"챕터 {i} 이미지 프롬프트 생성 중..."
            img_prompt = generate_image_prompt(i, script, character_profile)

            jobs[job_id]["current_task"] = f"챕터 {i} 이미지 생성 중 (Gemini)..."
            try:
                generate_image(img_prompt, i)
                img_url = f"/images/chapter_{i:02d}.png"
            except Exception:
                img_url = None

            jobs[job_id]["results"].append({
                "chapter_num": i,
                "script": script,
                "image_prompt": img_prompt,
                "image_url": img_url,
            })

            jobs[job_id]["progress"] = i

        except Exception as e:
            jobs[job_id]["error"] = str(e)
            jobs[job_id]["status"] = "error"
            return

    jobs[job_id]["current_task"] = "유튜브 메타데이터 생성 중..."
    meta = generate_youtube_meta(story_title, conti_text)
    jobs[job_id]["meta"] = meta["raw"]
    jobs[job_id]["total"] = chapter_count
    jobs[job_id]["status"] = "done"


@app.route("/generate", methods=["POST"])
def generate():
    story_title   = request.form.get("story_title", "").strip()
    conti_text    = request.form.get("conti_text", "").strip()
    chapter_count = int(request.form.get("chapter_count", 10))

    if not story_title or not conti_text:
        return jsonify({"error": "제목과 콘티를 입력해주세요."}), 400

    chapter_count = max(1, min(chapter_count, 10))

    job_id = str(uuid.uuid4())
    jobs[job_id] = {
        "status": "starting",
        "progress": 0,
        "total": chapter_count,
        "current_task": "준비 중...",
        "results": [],
        "meta": "",
    }

    threading.Thread(
        target=run_generation,
        args=(job_id, story_title, chapter_count, conti_text),
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
    app.run(debug=False, host='0.0.0.0', port=5000)
