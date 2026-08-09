import os
import threading
import uuid
from flask import Flask, render_template, request, jsonify, send_from_directory

from gemini_image import generate_image

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 32 * 1024 * 1024
app.config["TEMPLATES_AUTO_RELOAD"] = True

jobs = {}


def run_generation(job_id, prompts):
    try:
        total = len(prompts)
        jobs[job_id]["total"] = total
        images = []

        for idx, prompt in enumerate(prompts):
            photo_num = idx + 1
            jobs[job_id]["current_task"] = f"사진 {photo_num} / {total} 생성 중..."
            try:
                generate_image(prompt, 0, photo_num)
                img_url = f"/images/사진{photo_num}.png"
            except Exception as e:
                img_url = None
                jobs[job_id][f"error_{photo_num}"] = str(e)

            images.append({
                "photo_num": photo_num,
                "prompt":    prompt,
                "image_url": img_url,
            })
            jobs[job_id]["images"] = images
            jobs[job_id]["progress"] = photo_num

        jobs[job_id]["status"] = "done"
        jobs[job_id]["current_task"] = f"완료! ({total}장 생성됨)"

    except Exception as e:
        jobs[job_id]["error"] = str(e)
        jobs[job_id]["status"] = "error"


@app.route("/generate", methods=["POST"])
def generate():
    raw = request.form.get("prompts", "").strip()
    if not raw:
        return jsonify({"error": "프롬프트를 입력해주세요."}), 400

    prompts = [line.strip() for line in raw.splitlines() if line.strip()]
    if not prompts:
        return jsonify({"error": "프롬프트를 입력해주세요."}), 400

    job_id = str(uuid.uuid4())
    jobs[job_id] = {
        "status":       "running",
        "progress":     0,
        "total":        len(prompts),
        "current_task": "시작 중...",
        "images":       [],
    }

    threading.Thread(
        target=run_generation,
        args=(job_id, prompts),
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
