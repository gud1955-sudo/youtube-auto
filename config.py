import os
from dotenv import load_dotenv

load_dotenv()

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
YOUTUBE_CLIENT_SECRET_FILE = os.getenv("YOUTUBE_CLIENT_SECRET_FILE", "client_secret.json")

DEFAULT_TAGS = ["시니어", "감동사연", "인생이야기", "가족이야기", "오디오드라마", "감동영상"]
