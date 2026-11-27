
import re
from datetime import date, datetime

from pipecat.adapters.llm.schemas.function_schema import FunctionSchema

from services.appointment_service import (
    check_doctor_availability,
    book_appointment,
    cancel_appointment,
    load_appointments,
    DOCTORS,
    validate_phone_number,
    normalize_phone_number,
)


def _message_text(message):
    """Extract readable text from a conversation message."""

    if isinstance(message, dict):
        content = message.get("content", "")
    else:
        content = getattr(message, "content", "")

    if isinstance(content, str):
        return content

    if isinstance(content, list):
        parts = []

        for item in content:
            if isinstance(item, dict):
                parts.append(str(item.get("text", "")))
            else:
                parts.append(str(getattr(item, "text", "")))

        return " ".join(parts)

    return ""


def _message_role(message):
    if isinstance(message, dict):
        return message.get("role")

    return getattr(message, "role", None)


def _get_confirmation_messages(params):
    """Get the latest caller response and preceding assistant message."""

    messages = params.context.get_messages()

    last_user_index = None

    for index in range(len(messages) - 1, -1, -1):
        if _message_role(messages[index]) == "user":
            last_user_index = index
            break

    if last_user_index is None:
        return "", ""

    user_text = _message_text(messages[last_user_index])
    assistant_text = ""

    for index in range(last_user_index - 1, -1, -1):
        if _message_role(messages[index]) == "assistant":
            assistant_text = _message_text(messages[index])

            if assistant_text.strip():
                break

    return assistant_text, user_text


def _normalise_text(value):
    """Lower-case text and reduce it to plain words and digits.

    Apostrophes are removed (not turned into spaces) so that "that's" becomes
    "thats" rather than "that s".
    """

    text = str(value or "").lower().replace("\u2019", "'")
    text = text.replace("'", "")

    return re.sub(r"[^a-z0-9]+", " ", text).strip()


# Words that clearly mean "yes".
_AFFIRMATIVE_WORDS = {
    "yes", "yeah", "yep", "yup", "correct", "confirmed", "confirm",
    "proceed", "agree", "absolutely", "definitely", "sure", "okay", "ok",
    "affirmative",
}

# Short phrases that also mean "yes".
_AFFIRMATIVE_PHRASES = (
    "go ahead",
    "do it",
    "that is right",
    "thats right",
    "that is correct",
    "thats correct",
    "sounds good",
)

# If any of these appear, the reply is NOT treated as a clean confirmation
# (for example "yes but change the time"). Re-asking is always the safe choice.
_BLOCKING_WORDS = {
    "no", "nope", "not", "dont", "wrong", "incorrect", "but", "wait",
    "actually", "instead", "change", "however", "never", "stop",
}


def _is_affirmative(value):
    """Accept clear, short affirmative replies such as "Yes, that's correct".

    Long replies and replies containing any negation or correction are
    rejected so the assistant asks again instead of acting by mistake.
    """

    text = _normalise_text(value)
    words = text.split()

    if not words or len(words) > 8:
        return False

    if any(word in _BLOCKING_WORDS for word in words):
        return False

    if any(word in _AFFIRMATIVE_WORDS for word in words):
        return True

    return any(phrase in text for phrase in _AFFIRMATIVE_PHRASES)


def _is_negative(value):
    """Recognise clear negative responses."""

    text = _normalise_text(value)
    words = text.split()

    if not words:
        return False

    if words[0] in {"no", "nope", "nah", "incorrect", "wrong", "stop"}:
        return True

    if text in {"cancel", "never mind", "nevermind"}:
        return True

    return any(
        phrase in text
        for phrase in (
            "not correct",
            "not right",
            "thats wrong",
            "that is wrong",
            "wrong number",
            "dont proceed",
            "do not proceed",
            "dont book",
            "do not book",
            "dont cancel",
            "do not cancel",
        )
    )


def _phone_was_read_back(assistant_text, phone_number):
    """Check whether the assistant read the complete phone number."""

    spoken_digits = normalize_phone_number(assistant_text)

    return phone_number in spoken_digits


def _date_was_read_back(assistant_text, appointment_date):
    """Check whether the assistant read the appointment date.

    Accepts ISO dates and natural spoken forms such as "November 26",
    "November 26th, 2026", "26 November" and "26th of November".
    """

    try:
        parsed = date.fromisoformat(appointment_date)
    except (ValueError, TypeError):
        return False

    text = _normalise_text(assistant_text)

    if _normalise_text(appointment_date) in text:
        return True

    month = parsed.strftime("%B").lower()
    day = parsed.day
    suffix = r"(?:st|nd|rd|th)?"

    patterns = (
        rf"\b{month}\s+0?{day}{suffix}\b",
        rf"\b0?{day}{suffix}\s+(?:of\s+)?{month}\b",
    )

    return any(re.search(pattern, text) for pattern in patterns)


def _time_was_read_back(assistant_text, appointment_time):
    """Check common spoken representations of an appointment time."""

    try:
        parsed = datetime.strptime(appointment_time, "%I:%M %p")
    except (ValueError, TypeError):
        return False

    # Turn "p.m." / "a.m." into "pm" / "am" before normalising.
    spoken = re.sub(r"\b([ap])\.\s?m\.?", r"\1m", str(assistant_text).lower())
    text = _normalise_text(spoken)

    hour = parsed.hour % 12 or 12
    period = parsed.strftime("%p")

    alternatives = [
        f"{parsed.strftime('%I:%M')} {period}",
        f"{hour}:{parsed.strftime('%M')} {period}",
        f"{parsed.strftime('%I')} {period}",
        f"{hour} {period}",
    ]

    return any(
        _normalise_text(item) in text
        for item in alternatives
    )


def _action_was_read_back(params, expected_details):
    """Check the preceding assistant read-back and latest caller approval."""

    assistant_text, user_text = _get_confirmation_messages(params)

    if not assistant_text or not user_text:
        return False

    if not _is_affirmative(user_text):
        return False

    if "phone_number" in expected_details:
        return _phone_was_read_back(
            assistant_text,
            expected_details["phone_number"],
        )

    spoken_text = _normalise_text(assistant_text)

    name_words = [
        word
        for word in _normalise_text(expected_details["doctor_name"]).split()
        if word not in {"dr", "doctor"}
    ]

    if not all(word in spoken_text.split() for word in name_words):
        return False

    if not _date_was_read_back(
        assistant_text,
        expected_details["date"],
    ):
        return False

    if not _time_was_read_back(
        assistant_text,
        expected_details["time"],
    ):
        return False

    return True


def create_appointment_tools():
    """
    Create appointment tools with isolated per-call confirmation state.

    Each voice-call session gets its own independent state.
    """

    session_state = {
        "pending_phone_number": None,
        "confirmed_phone_number": None,
        "pending_booking": None,
        "pending_cancellation_id": None,
    }

    async def check_availability_handler(params):
        arguments = params.arguments

        result = check_doctor_availability(
            speciality=arguments["speciality"],
            appointment_date=arguments["appointment_date"],
        )

        await params.result_callback(result)

    async def confirm_phone_handler(params):
        phone_number = params.arguments["phone_number"]

        if not validate_phone_number(phone_number):
            session_state["pending_phone_number"] = None
            session_state["confirmed_phone_number"] = None
            session_state["pending_booking"] = None
            session_state["pending_cancellation_id"] = None

            result = {
                "success": False,
                "confirmed": False,
                "message": (
                    "Invalid phone number. Ask the caller to repeat it."
                ),
            }

        else:
            phone_number = normalize_phone_number(phone_number)

            if (
                session_state["pending_phone_number"]
                != phone_number
            ):
                session_state["pending_phone_number"] = phone_number
                session_state["confirmed_phone_number"] = None

                result = {
                    "success": True,
                    "confirmed": False,
                    "requires_confirmation": True,
                    "message": (
                        "The phone number has NOT been confirmed. "
                        "Read the complete phone number back to the caller "
                        "and ask whether it is correct. Wait for an explicit "
                        "yes before calling this tool again."
                    ),
                }

            elif _action_was_read_back(
                params,
                {"phone_number": phone_number},
            ):
                session_state["confirmed_phone_number"] = phone_number

                result = {
                    "success": True,
                    "confirmed": True,
                    "message": (
                        "The caller's phone number is confirmed "
                        "for this call session."
                    ),
                }

            else:
                _, user_text = _get_confirmation_messages(params)

                if _is_negative(user_text):
                    session_state["pending_phone_number"] = None

                result = {
                    "success": False,
                    "confirmed": False,
                    "requires_confirmation": True,
                    "message": (
                        "The phone number has not been confirmed. "
                        "Do not proceed until the caller explicitly "
                        "confirms the number."
                    ),
                }

        await params.result_callback(result)

    async def book_appointment_handler(params):
        arguments = params.arguments

        confirmed_phone = session_state["confirmed_phone_number"]

        if not confirmed_phone:
            result = {
                "success": False,
                "message": (
                    "The caller's phone number is not confirmed. "
                    "Confirm it before booking."
                ),
            }

        else:
            booking = {
                "doctor_id": arguments["doctor_id"],
                "appointment_date": arguments["appointment_date"],
                "time": arguments["time"],
            }

            doctor = next(
                (
                    item for item in DOCTORS
                    if item["doctor_id"] == booking["doctor_id"]
                ),
                None,
            )

            if doctor is None:
                result = {
                    "success": False,
                    "message": "Doctor not found.",
                }

            elif session_state["pending_booking"] != booking:
                session_state["pending_booking"] = booking

                result = {
                    "success": True,
                    "booked": False,
                    "requires_confirmation": True,
                    "doctor_name": doctor["doctor_name"],
                    "date": booking["appointment_date"],
                    "time": booking["time"],
                    "message": (
                        "The appointment has NOT been booked. "
                        "Read the doctor's name, date and time to the caller. "
                        "Ask for explicit approval. Call this tool again "
                        "with exactly the same arguments only after the "
                        "caller explicitly agrees."
                    ),
                }

            elif not _action_was_read_back(
                params,
                {
                    "doctor_name": doctor["doctor_name"],
                    "date": booking["appointment_date"],
                    "time": booking["time"],
                },
            ):
                _, user_text = _get_confirmation_messages(params)

                if _is_negative(user_text):
                    session_state["pending_booking"] = None

                result = {
                    "success": False,
                    "booked": False,
                    "requires_confirmation": True,
                    "message": (
                        "The appointment has NOT been booked. "
                        "The caller must explicitly approve the "
                        "doctor, date and time."
                    ),
                }

            else:
                result = book_appointment(
                    phone_number=confirmed_phone,
                    doctor_id=booking["doctor_id"],
                    appointment_date=booking["appointment_date"],
                    time=booking["time"],
                )

                if result.get("success"):
                    session_state["pending_booking"] = None

        await params.result_callback(result)

    async def cancel_appointment_handler(params):
        arguments = params.arguments

        confirmed_phone = session_state["confirmed_phone_number"]

        if not confirmed_phone:
            result = {
                "success": False,
                "message": (
                    "The caller's phone number is not confirmed. "
                    "Confirm it before looking up appointments."
                ),
            }

        else:
            appointments = [
                item
                for item in load_appointments()
                if item["phone_number"] == confirmed_phone
                and item["status"] == "booked"
            ]

            appointment_id = arguments.get("appointment_id")

            if not appointment_id:
                if not appointments:
                    result = {
                        "success": False,
                        "message": (
                            "No active appointments found "
                            "for this phone number."
                        ),
                    }

                else:
                    result = {
                        "success": True,
                        "cancelled": False,
                        "appointments": appointments,
                        "message": (
                            "These are the caller's active appointments. "
                            "Do not cancel anything yet. Ask which "
                            "appointment they want to cancel."
                        ),
                    }

            else:
                target = next(
                    (
                        item for item in appointments
                        if item["appointment_id"] == appointment_id
                    ),
                    None,
                )

                if target is None:
                    result = {
                        "success": False,
                        "message": (
                            "No matching active appointment found."
                        ),
                    }

                elif (
                    session_state["pending_cancellation_id"]
                    != appointment_id
                ):
                    session_state["pending_cancellation_id"] = (
                        appointment_id
                    )

                    result = {
                        "success": True,
                        "cancelled": False,
                        "requires_confirmation": True,
                        "appointment": target,
                        "message": (
                            "The appointment has NOT been cancelled. "
                            "Read the doctor's name, date and time to "
                            "the caller. Ask for explicit approval. "
                            "Call this tool again with the same "
                            "appointment ID only after the caller "
                            "explicitly agrees."
                        ),
                    }

                elif not _action_was_read_back(
                    params,
                    {
                        "doctor_name": target["doctor_name"],
                        "date": target["date"],
                        "time": target["time"],
                    },
                ):
                    _, user_text = _get_confirmation_messages(params)

                    if _is_negative(user_text):
                        session_state["pending_cancellation_id"] = None

                    result = {
                        "success": False,
                        "cancelled": False,
                        "requires_confirmation": True,
                        "message": (
                            "The appointment has NOT been cancelled. "
                            "The caller must explicitly approve "
                            "cancellation of this appointment."
                        ),
                    }

                else:
                    result = cancel_appointment(
                        phone_number=confirmed_phone,
                        appointment_id=appointment_id,
                    )

                    if result.get("success"):
                        session_state["pending_cancellation_id"] = None

        await params.result_callback(result)

    return [
        FunctionSchema(
            name="check_doctor_availability",
            description=(
                "Check available doctors and appointment slots "
                "for a medical speciality on a given date."
            ),
            properties={
                "speciality": {
                    "type": "string",
                    "description": (
                        "Medical speciality requested by the caller."
                    ),
                },
                "appointment_date": {
                    "type": "string",
                    "description": "Appointment date in YYYY-MM-DD format.",
                },
            },
            required=["speciality", "appointment_date"],
            handler=check_availability_handler,
        ),

        FunctionSchema(
            name="confirm_phone_number",
            description=(
                "Begin or complete confirmation of the caller's phone "
                "number. The caller must explicitly approve the number "
                "after it has been read back."
            ),
            properties={
                "phone_number": {
                    "type": "string",
                    "description": "Phone number spoken by the caller.",
                },
            },
            required=["phone_number"],
            handler=confirm_phone_handler,
        ),

        FunctionSchema(
            name="book_appointment",
            description=(
                "Prepare or complete appointment booking. Explicit "
                "caller approval of the doctor, date and time is required."
            ),
            properties={
                "doctor_id": {
                    "type": "string",
                    "description": "ID of the selected doctor.",
                },
                "appointment_date": {
                    "type": "string",
                    "description": "Appointment date in YYYY-MM-DD format.",
                },
                "time": {
                    "type": "string",
                    "description": "Exact available time slot.",
                },
            },
            required=["doctor_id", "appointment_date", "time"],
            handler=book_appointment_handler,
        ),

        FunctionSchema(
            name="cancel_appointment",
            description=(
                "Find or prepare cancellation of an appointment. "
                "Never cancel until the caller explicitly approves "
                "the specific appointment after its details are read back."
            ),
            properties={
                "appointment_id": {
                    "type": "string",
                    "description": (
                        "Appointment ID to prepare or confirm cancellation. "
                        "Omit it to list active appointments."
                    ),
                },
            },
            required=[],
            handler=cancel_appointment_handler,
        ),
    ]
