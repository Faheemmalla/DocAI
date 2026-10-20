import base64
import io
import json
import secrets
from pathlib import Path
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import HTMLResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from openai import OpenAI
from uuid import uuid4
from app.config import settings
from app.agent import graph, stream_graph

ROOT=Path(__file__).resolve().parent.parent
app=FastAPI(title='Medical Agent Educational API',version='1.0.0')
app.add_middleware(CORSMiddleware,allow_origins=settings.allowed_origins.split(','),allow_credentials=False,allow_methods=['GET','POST'],allow_headers=['Authorization','Content-Type','X-Conversation-ID'])
app.mount('/static',StaticFiles(directory=ROOT/'static'),name='static')


class ChatRequest(BaseModel):
    message: str = Field(min_length=1,max_length=4000)
    history: list[dict[str,str]] = Field(default_factory=list,max_length=10)
    image_data: str | None = None
    stream: bool = True

def auth(authorization: str | None):
    if settings.api_token and not secrets.compare_digest(authorization or '',f'Bearer {settings.api_token}'):
        raise HTTPException(status_code=401,detail='Invalid API token')


def inspect_image(data):
    if not data:
        return ''
    try:
        header,payload=data.split(',',1)
        mime=header.split(';')[0].split(':')[1]
        raw=base64.b64decode(payload,validate=True)
        if mime not in ('image/jpeg','image/png','image/webp') or len(raw)>5_000_000:
            raise ValueError('Only JPEG/PNG/WebP under 5MB supported')
    except (ValueError,IndexError) as exc:
        raise HTTPException(status_code=400,detail=f'Invalid image: {exc}')
    client=OpenAI(api_key=settings.openai_api_key,timeout=45)
    result=client.chat.completions.create(model=settings.openai_vision_model,messages=[{'role':'user','content':[{'type':'text','text':'Describe only objectively visible medical-relevant features. Do not diagnose, estimate severity, or assert absence of illness. If image unclear, say so.'},{'type':'image_url','image_url':{'url':data}}]}],max_tokens=300)
    return result.choices[0].message.content or ''


@app.get('/',response_class=HTMLResponse)
def home():
    return (ROOT/'templates'/'index.html').read_text(encoding='utf-8')

@app.get('/api/health')
def health():
    return {'status':'ok','configured':bool(settings.openai_api_key and settings.pinecone_api_key),'tavily':bool(settings.tavily_api_key),'streaming':settings.enable_streaming}



@app.post('/api/chat')
def chat(
    payload: ChatRequest,
    authorization: str | None = Header(default=None),
    conversation_id: str | None = Header(default=None, alias='X-Conversation-ID')
):
    auth(authorization)

    if not settings.openai_api_key or not settings.pinecone_api_key:
        raise HTTPException(503,'Set OPENAI_API_KEY and PINECONE_API_KEY in .env')

    history=[x for x in payload.history if x.get('role') in ('user','assistant') and isinstance(x.get('content'),str)][:10]

    # SQLite persistent memory: reuse the same conversation thread
    thread_id = conversation_id or str(uuid4())
    config = {"configurable": {"thread_id": thread_id}}

    should_stream = payload.stream and settings.enable_streaming

    if not should_stream:
        # Non-streaming fallback path
        try:
            observation = inspect_image(payload.image_data)
            state = graph.invoke(
                {
                    'question': payload.message,
                    'history': history,
                    'image_description': observation,
                    'kb': [],
                    'web': [],
                    'answer': '',
                    'route': ''
                },
                config=config
            )

            return {
                'answer': state['answer'],
                'sources': [{'type':'pdf','page':x['page'],'score':x['score']} for x in state['kb']]+[{'type':'web','url':x['url'],'title':x['title']} for x in state['web']],
                'tools': ['pinecone']+(['tavily'] if state['route']=='web' and settings.tavily_api_key else [])+(['vision'] if observation else []),
                'conversation_id': thread_id
            }

        except HTTPException:
            raise
        except Exception as exc:
            print('Chat error:', repr(exc), flush=True)
            raise HTTPException(502, 'AI service failed. Check server logs, credentials, Pinecone index, and connectivity.')

    # Incremental SSE streaming path
    def event_stream():
        try:
            observation = ''
            if payload.image_data:
                yield f"data: {json.dumps({'type': 'status', 'message': 'Analyzing attached image…'})}\n\n"
                observation = inspect_image(payload.image_data)

            inputs = {
                'question': payload.message,
                'history': history,
                'image_description': observation,
                'kb': [],
                'web': [],
                'answer': '',
                'route': ''
            }

            tools_used = ['pinecone']
            if observation:
                tools_used.append('vision')

            for event_type, data in stream_graph(inputs, config=config):
                if event_type == 'status':
                    yield f"data: {json.dumps({'type': 'status', 'message': data['message']})}\n\n"
                elif event_type == 'token':
                    yield f"data: {json.dumps({'type': 'delta', 'text': data})}\n\n"
                elif event_type == 'done':
                    kb_sources = [{'type': 'pdf', 'page': x['page'], 'score': x['score']} for x in data.get('kb', [])]
                    web_sources = [{'type': 'web', 'url': x['url'], 'title': x['title']} for x in data.get('web', [])]
                    sources = kb_sources + web_sources

                    if data.get('route') == 'web' and settings.tavily_api_key and 'tavily' not in tools_used:
                        tools_used.append('tavily')

                    yield f"data: {json.dumps({'type': 'done', 'answer': data['answer'], 'sources': sources, 'tools': tools_used, 'conversation_id': thread_id})}\n\n"

            yield "data: [DONE]\n\n"

        except GeneratorExit:
            # Client disconnected / stream aborted
            return
        except HTTPException as exc:
            yield f"data: {json.dumps({'type': 'error', 'detail': exc.detail})}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as exc:
            print('Streaming chat error:', repr(exc), flush=True)
            yield f"data: {json.dumps({'type': 'error', 'detail': 'AI service failed. Check server logs, credentials, Pinecone index, and connectivity.'})}\n\n"
            yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_stream(),
        media_type='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Content-Type': 'text/event-stream; charset=utf-8',
            'X-Accel-Buffering': 'no',
            'X-Conversation-ID': thread_id
        }
    )


@app.post('/api/transcribe')
async def transcribe(file:UploadFile=File(...),authorization:str|None=Header(default=None)):
    auth(authorization)
    data=await file.read(10_000_001)
    if len(data)>10_000_000:
        raise HTTPException(413,'Audio exceeds 10 MB')
    audio=io.BytesIO(data); audio.name='voice.webm'
    try:
        result=OpenAI(api_key=settings.openai_api_key).audio.transcriptions.create(model='whisper-1',file=audio)
        return {'text':result.text}
    except Exception:
        raise HTTPException(502,'Speech transcription unavailable')

@app.post('/api/speak')
def speak(payload:dict,authorization:str|None=Header(default=None)):
    auth(authorization)
    text=str(payload.get('text',''))[:3000]
    if not text:
        raise HTTPException(400,'Missing text')
    try:
        client = OpenAI(api_key=settings.openai_api_key)
        def iter_audio():
            with client.audio.speech.with_streaming_response.create(
                model='tts-1',
                voice='alloy',
                input=text
            ) as response:
                for chunk in response.iter_bytes(chunk_size=4096):
                    yield chunk

        return StreamingResponse(
            iter_audio(),
            media_type='audio/mpeg',
            headers={
                'Cache-Control': 'no-cache',
                'X-Accel-Buffering': 'no'
            }
        )
    except Exception as exc:
        print('Speak error:', repr(exc), flush=True)
        raise HTTPException(502,'Speech synthesis unavailable')