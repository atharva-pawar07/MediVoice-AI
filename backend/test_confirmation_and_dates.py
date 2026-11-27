"""Tests for natural-speech confirmations and relative-date handling.

Run from the backend folder with:  python test_confirmation_and_dates.py
"""

import os
from datetime import date, datetime, timedelta
from unittest import mock

from services import appointment_service
from services.appointment_tools import (
    _date_was_read_back,
    _is_affirmative,
    _is_negative,
    _normalise_text,
    _time_was_read_back,
)


def check(condition, message):
    assert condition, message
    print("PASS:", message)


# ---------- affirmative / negative ----------
for phrase in [
    "Yes.", "Yes, that's correct.", "Yes that is correct", "Yeah",
    "Yep, go ahead", "Correct!", "Yes please cancel it", "Sure",
    "Okay, book it", "That's right.",
]:
    check(_is_affirmative(phrase), f"affirmative accepted: {phrase!r}")

for phrase in [
    "No", "No, that's wrong", "Yes but change the time", "Not correct",
    "Wait, actually make it Friday", "Yes it is the wrong number",
    "I would like to know the doctor's experience before I say yes please",
    "", "Hmm",
]:
    check(not _is_affirmative(phrase), f"not treated as yes: {phrase!r}")

for phrase in ["No", "Nope", "That's wrong", "Do not proceed", "Cancel"]:
    check(_is_negative(phrase), f"negative recognised: {phrase!r}")

check(not _is_negative("Yes, that's correct"), "yes is not negative")
check(_normalise_text("that's") == "thats", "apostrophe removed")

# ---------- date read-back ----------
d = "2026-11-27"
for text in [
    "That is Friday, November 27 at 10:00 AM",
    "November 27th, 2026", "27 November", "the 27th of November",
    "2026-11-27",
]:
    check(_date_was_read_back(text, d), f"date read-back accepted: {text!r}")

check(not _date_was_read_back("November 28", d), "wrong day rejected")
check(not _date_was_read_back("December 27", d), "wrong month rejected")
check(not _date_was_read_back("November 270", d), "partial day number rejected")

# ---------- time read-back ----------
for text in ["10:00 AM", "10 AM", "ten... 10 a.m.", "10:00 a.m."]:
    check(_time_was_read_back(text, "10:00 AM"), f"time read-back accepted: {text!r}")
for text in ["2 PM", "2:00 p.m.", "02:00 PM"]:
    check(_time_was_read_back(text, "02:00 PM"), f"time read-back accepted: {text!r}")
check(not _time_was_read_back("11:00 AM", "10:00 AM"), "wrong time rejected")

# ---------- timezone-aware today ----------
with mock.patch.dict(os.environ, {"APP_TIMEZONE": "Asia/Kolkata"}):
    now = appointment_service.get_local_now()
    check(now.utcoffset() == timedelta(hours=5, minutes=30), "Asia/Kolkata is UTC+05:30")

with mock.patch.dict(os.environ, {"APP_TIMEZONE": "Not/AReal_Zone"}):
    now = appointment_service.get_local_now()
    check(isinstance(now, datetime), "invalid timezone falls back to local time")

# validate_date: yesterday rejected, today and tomorrow accepted
today = appointment_service.get_today()
check(appointment_service.validate_date(today.isoformat()), "today accepted")
check(appointment_service.validate_date((today + timedelta(days=1)).isoformat()), "tomorrow accepted")
check(not appointment_service.validate_date((today - timedelta(days=1)).isoformat()), "yesterday rejected")
check(not appointment_service.validate_date("2025-02-19"), "the old wrong date 2025-02-19 is rejected")
print("\nALL CONFIRMATION/DATE TESTS PASSED")
