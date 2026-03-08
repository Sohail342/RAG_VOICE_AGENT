import logging

import pymupdf
from fastapi import APIRouter, File, HTTPException, Request, UploadFile

router = APIRouter()
logger = logging.getLogger(__name__)


@router.get("")
async def list_files(request: Request):
    """List all uploaded files embedded in the vector database."""
    rag = getattr(request.app.state, "rag", None)
    if not rag:
        raise HTTPException(status_code=500, detail="RAG system is not initialized.")

    try:
        files = rag.get_uploaded_files()
        return {"status": "success", "files": files}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/upload")
async def upload_file(
    request: Request,
    file: UploadFile = File(...),
):
    """
    Upload a text or PDF file, extract its text, and store chunks in Qdrant for RAG.
    """
    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided.")

    allowed_extensions = [".txt", ".md", ".pdf"]
    ext = ""
    for allowed in allowed_extensions:
        if file.filename.lower().endswith(allowed):
            ext = allowed
            break

    if not ext:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type. Allowed: {allowed_extensions}",
        )

    try:
        content_bytes = await file.read()
        text = ""

        if ext in [".txt", ".md"]:
            text = content_bytes.decode("utf-8")
        elif ext == ".pdf":
            # Use PyMuPDF to extract text from PDF memory stream
            doc = pymupdf.open(stream=content_bytes, filetype="pdf")
            extracted_pages = []
            for page_num in range(len(doc)):
                page = doc.load_page(page_num)
                extracted_pages.append(page.get_text())
            text = "\n".join(extracted_pages)

        if not text.strip():
            raise HTTPException(
                status_code=400,
                detail="The file is empty or contains no readable text.",
            )

        # Get global RAG system
        rag = getattr(request.app.state, "rag", None)
        if not rag:
            raise HTTPException(
                status_code=500, detail="RAG system is not initialized."
            )

        metadata = {"filename": file.filename, "uploaded_by": "User"}

        chunks_inserted = await rag.upsert_document(text, metadata)

        return {
            "status": "success",
            "message": f"Successfully processed {file.filename}",
            "chunks_embedded": chunks_inserted,
        }

    except Exception as e:
        logger.error(f"Error processing file {file.filename}: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to process file: {str(e)}")
