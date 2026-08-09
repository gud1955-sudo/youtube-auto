import os
from google import genai
from google.genai import types
from config import GEMINI_API_KEY


def _client():
    return genai.Client(api_key=GEMINI_API_KEY)


def generate_image(prompt: str, chapter_num: int, output_dir: str = "output_images") -> str:
    os.makedirs(output_dir, exist_ok=True)

    response = _client().models.generate_images(
        model="imagen-3.0-generate-002",
        prompt=prompt,
        config=types.GenerateImagesConfig(
            number_of_images=1,
            aspect_ratio="16:9",
            safety_filter_level="block_low_and_above",
        ),
    )

    image_path = os.path.join(output_dir, f"chapter_{chapter_num:02d}.png")
    for img in response.generated_images:
        img.image.save(image_path)
    return image_path


def generate_thumbnail(prompt: str, output_dir: str = "output_images") -> str:
    os.makedirs(output_dir, exist_ok=True)

    response = _client().models.generate_images(
        model="imagen-3.0-generate-002",
        prompt=prompt,
        config=types.GenerateImagesConfig(
            number_of_images=1,
            aspect_ratio="16:9",
            safety_filter_level="block_low_and_above",
        ),
    )

    image_path = os.path.join(output_dir, "thumbnail.png")
    for img in response.generated_images:
        img.image.save(image_path)
    return image_path
