# Changes in this version

## Root causes and fixes

| # | Problem | Cause | Fix |
|---|---------|-------|-----|
| A | AI voice not audible | `SmallWebRTCTransport` 1.11.3 builds its media manager with the player disabled and only *announces* the remote audio track. `App.jsx` never attached that track to anything that plays sound. | `frontend/src/App.jsx`: one `<audio autoPlay>` element, fed from `onTrackStarted` (remote audio only, never the local mic), same track never attached twice, released on disconnect. |
| B | Transcript up to ~34 s late | ElevenLabs STT is in manual-commit mode and commits only when Pipecat's VAD reports the caller stopped speaking. `main.py` configured no VAD, so that signal never existed (the default Smart Turn analyzer also relies on it). | `backend/main.py`: `SileroVADAnalyzer` (`stop_secs=0.2`) on `LLMUserAggregatorParams`. |
| C | Repeated assistant text | One sentence is reported by several `bot-output` events with the same `segment_id` (`new`, `in-progress`, `completed`). The UI appended every event's text. | `frontend/src/App.jsx`: progress events are ignored, and a repeated `segment_id` replaces instead of appends. |
| D | Repeated turns | Most likely a consequence of A and B. | `backend/services/turn_guard.py`: drops a final transcript only if identical to the previous one and received within 2 s; every drop is logged. |
| E | Wrong relative dates | The LLM was never told today's date. | `backend/main.py` injects today's date and a 15-day calendar into the system prompt (timezone from `APP_TIMEZONE`, default `Asia/Kolkata`); `appointment_service.py` validates against the same timezone. |

## Additional fixes found during review

- `appointment_tools.py`: "Yes, that's correct" was rejected (apostrophe turned into a space, exact-phrase matching). Confirmation matching now accepts natural short yes/no replies, still rejects anything with a negation or correction, and understands dates like "26th November", times like "10 a.m.", and "Doctor Ananya Sharma".
- `main.py`: the pipeline is cancelled when the browser disconnects (previously it kept running after each call).
- `main.py`: CORS also allows `http://127.0.0.1:5173`.
- `frontend/package.json`: `@pipecat-ai/client-js` is now declared (it was imported but only present as a peer dependency).
- `frontend/src/App.jsx`: removed the `onRemoteAudioLevel` diagnostic (this transport never calls it, so it could not work); the audio diagnostic now reflects real events.

## Changed files

- backend/main.py
- backend/services/appointment_service.py
- backend/services/appointment_tools.py
- backend/services/turn_guard.py (new)
- backend/test_confirmation_and_dates.py (new)
- backend/requirements.txt (adds `tzdata`)
- frontend/src/App.jsx
- frontend/package.json, frontend/package-lock.json
- .env.example, README.md, CHANGES.md

## Manual test checklist (needs a real microphone and speakers)

1. Start backend and frontend; open http://localhost:5173/; click **Start call**.
2. You should hear a spoken reply to your first sentence, and the dashboard's
   "Audio diagnostic" should read "AI audio is playing through your browser."
3. Say one sentence. In the backend terminal, `Committed transcript` should
   appear within about a second of you stopping.
4. Each assistant sentence appears once in the transcript (dashboard and phone panel).
5. Say "I want a cardiologist tomorrow". The tool call must use tomorrow's real date.
6. Book: give a phone number, confirm it, confirm the appointment. Check the
   Appointments table updates.
7. Cancel the same appointment the same way.
8. Click **End call**: the backend terminal should log "Voice pipeline stopped".

## Known limitations

- Not tested with a live microphone, speakers, ElevenLabs or Gemini in the environment where these changes were made.
- Appointments are stored in a JSON file without locking; fine for one demo user.
- Pipecat prints a deprecation warning for `PipelineTask` (still supported until Pipecat 2.0).
- Silero VAD uses Pipecat's default sensitivity. If quiet speech is missed, tune `VADParams` in `main.py`.
