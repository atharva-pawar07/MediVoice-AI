# MediVoice AI

A real-time voice AI doctor appointment booking assistant.

## Technology Stack

- Python, FastAPI
- Pipecat (SmallWebRTC transport, RTVI protocol)
- ElevenLabs (realtime speech-to-text and text-to-speech)
- Google Gemini (with function calling)
- React + Vite
- JSON file persistence

## Core Features

- Doctor availability checking
- Voice-based appointment booking and cancellation
- Spoken phone-number and appointment read-back with explicit confirmation
- Live conversation transcript
- Appointment dashboard

## Setup

1. Copy `.env.example` to `backend/.env` and fill in your own keys.
   Never commit `backend/.env` (it is already in `.gitignore`).
2. Backend (from the `backend` folder, with the virtual environment active):
   ```powershell
   pip install -r requirements.txt
   python -m uvicorn main:app --reload
   ```
3. Frontend (from the `frontend` folder):
   ```powershell
   npm.cmd install
   npm.cmd run dev
   ```
4. Open http://localhost:5173/, click **Start call**, and allow the microphone.

Use headphones for the best results: with laptop speakers the microphone can
pick up the assistant's own voice.

## Tests

From the `backend` folder:

```powershell
python test_appointment_service.py
python test_appointment_tools.py
python test_confirmation_and_dates.py
```

## How the voice pipeline works

Microphone -> WebRTC -> ElevenLabs STT -> Gemini (+ appointment tools)
-> ElevenLabs TTS -> WebRTC -> **an `<audio>` element in `App.jsx`**.

Two details matter and are easy to miss:

- The browser client does not play the assistant's voice by itself; `App.jsx`
  attaches the incoming audio track to a single `<audio>` element.
- Speech is committed to the LLM when Pipecat's VAD (Silero, configured on the
  user aggregator in `backend/main.py`) detects that the caller stopped talking.

See `CHANGES.md` for the full list of fixes and the manual test checklist.
