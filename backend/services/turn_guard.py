"""Protection against one spoken sentence being processed twice."""

import logging
import re
import time

from pipecat.frames.frames import Frame, TranscriptionFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

logger = logging.getLogger("medivoice")


def _normalise(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (text or "").lower()).strip()


class DuplicateTranscriptGuard(FrameProcessor):
    """Drop a final transcript that repeats the previous one almost instantly.

    If the speech-to-text service ever delivers the same committed transcript
    twice in a row, the LLM would answer the same sentence twice. This guard
    only drops a transcript when ALL of these are true:

    * its text is identical to the previous final transcript, and
    * it arrived within ``window_secs`` of that previous transcript.

    A caller who genuinely repeats a word later (for example answering "yes"
    to two separate questions) is never affected, because that takes longer
    than the window. Every drop is logged, so you can see in the backend
    terminal whether this guard ever actually fires.
    """

    def __init__(self, window_secs: float = 2.0, **kwargs):
        super().__init__(**kwargs)
        self._window_secs = window_secs
        self._last_text = None
        self._last_time = 0.0

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if (
            isinstance(frame, TranscriptionFrame)
            and direction == FrameDirection.DOWNSTREAM
        ):
            text = _normalise(frame.text)
            now = time.monotonic()

            if (
                text
                and text == self._last_text
                and (now - self._last_time) < self._window_secs
            ):
                logger.warning(
                    "Dropped duplicate transcript received %.2fs after the "
                    "previous one: %r",
                    now - self._last_time,
                    frame.text,
                )
                return

            self._last_text = text
            self._last_time = now

        await self.push_frame(frame, direction)
