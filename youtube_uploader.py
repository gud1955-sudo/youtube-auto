import os
import pickle
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload
from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request
from config import YOUTUBE_CLIENT_SECRET_FILE, DEFAULT_TAGS

SCOPES = ["https://www.googleapis.com/auth/youtube.upload"]
TOKEN_FILE = "youtube_token.pickle"


def get_authenticated_service():
    creds = None

    if os.path.exists(TOKEN_FILE):
        with open(TOKEN_FILE, "rb") as token:
            creds = pickle.load(token)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            if not os.path.exists(YOUTUBE_CLIENT_SECRET_FILE):
                raise FileNotFoundError(
                    f"YouTube 인증 파일이 없습니다: {YOUTUBE_CLIENT_SECRET_FILE}\n"
                    "Google Cloud Console에서 OAuth 클라이언트 ID를 다운로드하세요."
                )
            flow = InstalledAppFlow.from_client_secrets_file(YOUTUBE_CLIENT_SECRET_FILE, SCOPES)
            creds = flow.run_local_server(port=0)

        with open(TOKEN_FILE, "wb") as token:
            pickle.dump(creds, token)

    return build("youtube", "v3", credentials=creds)


def upload_video(
    video_path: str,
    title: str,
    description: str,
    tags: list = None,
    category_id: str = "22",
    privacy: str = "private",
) -> str:
    if not os.path.exists(video_path):
        raise FileNotFoundError(f"영상 파일을 찾을 수 없습니다: {video_path}")

    youtube = get_authenticated_service()

    if tags is None:
        tags = DEFAULT_TAGS

    body = {
        "snippet": {
            "title": title,
            "description": description,
            "tags": tags,
            "categoryId": category_id,
            "defaultLanguage": "ko",
        },
        "status": {
            "privacyStatus": privacy,  # private, public, unlisted
        },
    }

    media = MediaFileUpload(video_path, chunksize=-1, resumable=True)

    print(f"📤 업로드 시작: {title}")
    print(f"   파일: {video_path}")
    print(f"   공개 설정: {privacy}")

    request = youtube.videos().insert(part=",".join(body.keys()), body=body, media_body=media)

    response = None
    while response is None:
        status, response = request.next_chunk()
        if status:
            progress = int(status.progress() * 100)
            print(f"   업로드 진행률: {progress}%", end="\r")

    video_id = response["id"]
    video_url = f"https://www.youtube.com/watch?v={video_id}"

    print(f"\n✅ 업로드 완료!")
    print(f"   영상 ID: {video_id}")
    print(f"   URL: {video_url}")

    return video_url
