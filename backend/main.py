
import os
import asyncio
import logging

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.request_handler import (
    SmallWebRTCRequest,
    SmallWebRTCPatchRequest,
    SmallWebRTCRequestHandler,
)
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pipecat.transports.base_transport import TransportParams

from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.task import PipelineTask
from pipecat.pipeline.runner import PipelineRunner

from pipecat.processors.frameworks.rtvi import (
    RTVIProcessor,
    RTVIObserver,
    RTVIObserverParams,
)

from pipecat.services.elevenlabs.stt import ElevenLabsRealtimeSTTService
from pipecat.services.elevenlabs.tts import ElevenLabsTTSService
from pipecat.services.google.llm import GoogleLLMService

from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
)

from services.appointment_tools import create_appointment_tools
from services.appointment_service import (
    DOCTORS,
    load_appointments,
)

# --------------------------------------------------
# CONFIGURATION
# --------------------------------------------------

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("medivoice")

app = FastAPI(title="MediVoice AI")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

webrtc_handler = SmallWebRTCRequestHandler()
active_tasks = {}

SYSTEM_INSTRUCTION = """
You are MediVoice, a polite and professional doctor appointment booking assistant.

Your responsibilities:
1. Help callers find doctors and available appointment slots.
2. Help callers book appointments.
3. Help callers cancel existing appointments.

Important rules:
- Speak naturally and keep responses concise.
- Never claim that an appointment is booked or cancelled unless the corresponding tool succeeds.
- Ask for the caller's phone number before booking or cancellation.
- Read the complete phone number back to the caller.
- Obtain explicit verbal confirmation before proceeding.
- Never book or cancel without explicit confirmation.
- For booking, read the doctor, date, time, and phone number back and obtain explicit confirmation.
- For cancellation, identify the appointment, read its details and phone number back, and obtain explicit confirmation.
- If multiple appointments match, ask which one the caller means.
- Use the appointment tools to check availability and perform actions.
- Do not invent doctors, dates, slots, or appointment IDs.
- Ask one question at a time.
- Do not provide medical diagnosis or treatment advice.
"""

# --------------------------------------------------
# VOICE PIPELINE
# --------------------------------------------------

async def run_voice_pipeline(connection: SmallWebRTCConnection):
    logger.info("Starting MediVoice voice pipeline")

    transport = SmallWebRTCTransport(
        webrtc_connection=connection,
        params=TransportParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
        ),
    )

    rtvi = RTVIProcessor(transport=transport)

    @rtvi.event_handler("on_client_ready")
    async def on_client_ready(processor):
        logger.info("RTVI client is ready")
        await processor.set_bot_ready()

    # ElevenLabs realtime speech recognition.
    # Explicitly request English using the legacy InputParams interface.
    stt = ElevenLabsRealtimeSTTService(
        api_key=os.getenv("ELEVENLABS_API_KEY"),
        params=ElevenLabsRealtimeSTTService.InputParams(
            language_code="en"
        ),
    )

    # Gemini language model with appointment function calling.
    llm = GoogleLLMService(
        api_key=os.getenv("GEMINI_API_KEY"),
        settings=GoogleLLMService.Settings(
            model="gemini-3.5-flash-lite",
            system_instruction=SYSTEM_INSTRUCTION,
            temperature=0.2,
            max_tokens=500,
        ),
    )

    # ElevenLabs speech generation.
    tts = ElevenLabsTTSService(
        api_key=os.getenv("ELEVENLABS_API_KEY"),
        settings=ElevenLabsTTSService.Settings(
            voice="JBFqnCBsd6RMkjVDRZzb",
            model="eleven_flash_v2_5",
        ),
    )

    # Register appointment tools.
    tools = create_appointment_tools()

    # Conversation context.
    # System instruction is configured on GoogleLLMService above.
    context = LLMContext(
        messages=[],
        tools=tools,
    )

    context_aggregators = LLMContextAggregatorPair(context)

    # Pipeline order:
    # Microphone -> RTVI -> STT -> User context
    # -> Gemini -> ElevenLabs TTS -> Speaker
    pipeline = Pipeline(
        [
            transport.input(),
            rtvi,
            stt,
            context_aggregators.user(),
            llm,
            tts,
            transport.output(),
            context_aggregators.assistant(),
        ]
    )

    rtvi_observer = RTVIObserver(
        rtvi,
        params=RTVIObserverParams(
            user_transcription_enabled=True,
            bot_output_enabled=True,
            user_input_enabled=True,
        ),
    )

    task = PipelineTask(
        pipeline,
        observers=[rtvi_observer],
    )

    active_tasks[id(connection)] = task

    try:
        await PipelineRunner().run(task)

    except Exception:
        logger.exception("Voice pipeline failed")

    finally:
        active_tasks.pop(id(connection), None)
        logger.info("Voice pipeline stopped")


# --------------------------------------------------
# API ENDPOINTS
# --------------------------------------------------

@app.get("/")
async def root():
    return {
        "message": "MediVoice AI backend is running",
        "status": "ok",
    }


@app.get("/api/doctors")
async def get_doctors():
    return {
        "success": True,
        "doctors": DOCTORS,
    }


@app.get("/api/appointments")
async def get_appointments():
    appointments = load_appointments()

    return {
        "success": True,
        "appointments": appointments,
    }


# --------------------------------------------------
# WEBRTC CONNECTION
# --------------------------------------------------

@app.post("/api/offer")
async def offer(request: SmallWebRTCRequest):

    async def connection_callback(connection: SmallWebRTCConnection):
        asyncio.create_task(run_voice_pipeline(connection))

    return await webrtc_handler.handle_web_request(
        request=request,
        webrtc_connection_callback=connection_callback,
    )


@app.patch("/api/offer")
async def ice_candidate(request: SmallWebRTCPatchRequest):
    await webrtc_handler.handle_patch_request(request)

    return {
        "status": "success",
    }


# --------------------------------------------------
# SHUTDOWN
# --------------------------------------------------

@app.on_event("shutdown")
async def shutdown_event():
    logger.info("Shutting down MediVoice AI")

    for task in list(active_tasks.values()):
        await task.cancel()

    await webrtc_handler.close()
