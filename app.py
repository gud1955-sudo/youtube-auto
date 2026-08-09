import streamlit as st
import os
from datetime import datetime
from script_generator import generate_chapter, generate_image_prompt, generate_youtube_meta
from gemini_image import generate_image

st.set_page_config(
    page_title="시니어 유튜브 자동화",
    page_icon="🎬",
    layout="wide"
)

st.title("🎬 시니어 유튜브 콘텐츠 자동화")
st.markdown("---")

# ── 세션 상태 초기화 ──────────────────────────────
if "results" not in st.session_state:
    st.session_state.results = None
if "generating" not in st.session_state:
    st.session_state.generating = False

# ── 입력 섹션 ─────────────────────────────────────
col_left, col_right = st.columns([1, 1])

with col_left:
    st.subheader("📌 기본 정보")

    story_title = st.text_input(
        "영상 제목 (스토리 제목)",
        placeholder="예: 30년 만에 찾아온 아들의 비밀"
    )

    thumbnail_file = st.file_uploader(
        "썸네일 이미지 업로드 (미리캔버스 결과물)",
        type=["jpg", "jpeg", "png"]
    )

    if thumbnail_file:
        st.image(thumbnail_file, caption="업로드된 썸네일", use_container_width=True)

with col_right:
    st.subheader("📋 콘티 입력 (10챕터)")
    st.caption("각 챕터의 제목과 간단한 줄거리를 입력하세요")

    chapters = []
    for i in range(1, 11):
        with st.expander(f"챕터 {i}", expanded=(i <= 3)):
            title = st.text_input(f"챕터 {i} 제목", key=f"title_{i}",
                                  placeholder=f"예: 그날의 기억")
            outline = st.text_area(f"챕터 {i} 줄거리", key=f"outline_{i}",
                                   placeholder="2~3줄로 간단히 방향을 적어주세요",
                                   height=80)
            chapters.append({"title": title, "outline": outline})

st.markdown("---")

# ── 생성 버튼 ─────────────────────────────────────
generate_btn = st.button(
    "🚀 대본 + 이미지 자동 생성",
    type="primary",
    use_container_width=True,
    disabled=not story_title or not any(ch["title"] for ch in chapters)
)

# ── 생성 실행 ─────────────────────────────────────
if generate_btn:
    filled_chapters = [ch for ch in chapters if ch["title"] and ch["outline"]]

    if not filled_chapters:
        st.error("최소 1개 챕터의 제목과 줄거리를 입력해주세요.")
    else:
        thumbnail_bytes = thumbnail_file.read() if thumbnail_file else None

        full_context = f"제목: {story_title}\n챕터 구성:\n"
        for i, ch in enumerate(filled_chapters, 1):
            full_context += f"  챕터{i}: {ch['title']} - {ch['outline']}\n"

        results = []
        progress_bar = st.progress(0)
        status_text = st.empty()
        total = len(filled_chapters)

        for i, ch in enumerate(filled_chapters, 1):
            # 대본 생성
            status_text.info(f"✍️ 챕터 {i}/{total} 대본 생성 중... ({ch['title']})")
            script = generate_chapter(
                chapter_num=i,
                chapter_title=ch["title"],
                chapter_outline=ch["outline"],
                thumbnail_bytes=thumbnail_bytes if i == 1 else None,
                full_story_context=full_context,
            )

            # 이미지 프롬프트 생성
            status_text.info(f"🎨 챕터 {i}/{total} 이미지 프롬프트 생성 중...")
            img_prompt = generate_image_prompt(ch["title"], script)

            # Gemini 이미지 생성
            status_text.info(f"🖼️ 챕터 {i}/{total} Gemini 이미지 생성 중...")
            try:
                img_path = generate_image(img_prompt, i)
            except Exception as e:
                img_path = None
                st.warning(f"챕터 {i} 이미지 생성 실패: {e}")

            results.append({
                "chapter_num": i,
                "title": ch["title"],
                "script": script,
                "image_prompt": img_prompt,
                "image_path": img_path,
            })

            progress_bar.progress(i / total)

        # 유튜브 메타데이터 생성
        status_text.info("📝 유튜브 제목/설명 생성 중...")
        meta = generate_youtube_meta(story_title, filled_chapters)

        st.session_state.results = {
            "story_title": story_title,
            "chapters": results,
            "meta": meta,
        }

        progress_bar.progress(1.0)
        status_text.success("✅ 생성 완료!")

# ── 결과 표시 ─────────────────────────────────────
if st.session_state.results:
    res = st.session_state.results
    st.markdown("---")
    st.subheader("📄 생성 결과")

    # 유튜브 메타데이터
    with st.expander("📢 유튜브 제목 / 설명 / 태그", expanded=True):
        st.text_area("메타데이터", res["meta"]["raw"], height=200)

    # 전체 대본 다운로드
    full_script = f"제목: {res['story_title']}\n\n"
    for ch in res["chapters"]:
        full_script += f"=== 챕터 {ch['chapter_num']}: {ch['title']} ===\n\n"
        full_script += ch["script"] + "\n\n"

    st.download_button(
        label="📥 전체 대본 다운로드 (Vrew용)",
        data=full_script.encode("utf-8"),
        file_name=f"대본_{datetime.now().strftime('%Y%m%d_%H%M')}.txt",
        mime="text/plain",
        use_container_width=True,
    )

    st.markdown("---")

    # 챕터별 탭
    tab_labels = [f"챕터 {ch['chapter_num']}" for ch in res["chapters"]]
    tabs = st.tabs(tab_labels)

    for tab, ch in zip(tabs, res["chapters"]):
        with tab:
            st.markdown(f"### {ch['title']}")

            col1, col2 = st.columns([1, 1])

            with col1:
                st.markdown("**📝 대본**")
                st.text_area(
                    label="",
                    value=ch["script"],
                    height=400,
                    key=f"script_display_{ch['chapter_num']}"
                )
                st.caption(f"글자 수: {len(ch['script'])}자")

            with col2:
                st.markdown("**🖼️ 생성 이미지**")
                if ch["image_path"] and os.path.exists(ch["image_path"]):
                    st.image(ch["image_path"], use_container_width=True)
                    with open(ch["image_path"], "rb") as f:
                        st.download_button(
                            "이미지 다운로드",
                            f.read(),
                            file_name=f"chapter_{ch['chapter_num']:02d}.png",
                            key=f"dl_{ch['chapter_num']}"
                        )
                else:
                    st.info("이미지 생성 실패 또는 미생성")

                st.markdown("**🔤 이미지 프롬프트**")
                st.text_area(
                    label="",
                    value=ch["image_prompt"],
                    height=120,
                    key=f"prompt_display_{ch['chapter_num']}"
                )
