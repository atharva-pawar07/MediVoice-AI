
import json
import logging
import os
import re
from datetime import date, datetime
from pathlib import Path
from uuid import uuid4

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None

logger = logging.getLogger("medivoice")


# Timezone used to decide what "today" and "tomorrow" mean.
# Override with APP_TIMEZONE in backend/.env.
DEFAULT_TIMEZONE = "Asia/Kolkata"

DATA_FILE = (
    Path(__file__).resolve().parent.parent
    / "data"
    / "appointments.json"
)


DOCTORS = [
    {
        "doctor_id": "DOC001",
        "doctor_name": "Dr. Ananya Sharma",
        "speciality": "Cardiologist",
        "slots": ["10:00 AM", "11:00 AM", "02:00 PM"],
    },
    {
        "doctor_id": "DOC002",
        "doctor_name": "Dr. Rahul Mehta",
        "speciality": "Dermatologist",
        "slots": ["09:00 AM", "12:00 PM", "03:00 PM"],
    },
    {
        "doctor_id": "DOC003",
        "doctor_name": "Dr. Priya Nair",
        "speciality": "General Physician",
        "slots": ["10:00 AM", "01:00 PM", "04:00 PM"],
    },
]


# --------------------------------------------------
# SPECIALITY NORMALIZATION
# --------------------------------------------------

SPECIALITY_ALIASES = {
    "cardiology": "cardiologist",
    "cardiologist": "cardiologist",
    "dermatology": "dermatologist",
    "dermatologist": "dermatologist",
    "general medicine": "general physician",
    "general physician": "general physician",
    "general practice": "general physician",
    "physician": "general physician",
}


def normalize_speciality(speciality: str) -> str:
    """Normalize common speciality names and aliases."""

    normalized = re.sub(
        r"\s+",
        " ",
        speciality.strip().lower(),
    )

    return SPECIALITY_ALIASES.get(normalized, normalized)


# --------------------------------------------------
# PHONE NUMBER VALIDATION
# --------------------------------------------------

def validate_phone_number(phone_number: str) -> bool:
    """Accept international-style phone numbers containing 7–15 digits."""

    digits = re.sub(r"\D", "", phone_number)

    return 7 <= len(digits) <= 15


def normalize_phone_number(phone_number: str) -> str:
    """Keep only digits for consistent phone-number comparison."""

    return re.sub(r"\D", "", phone_number)


# --------------------------------------------------
# DATE AND TIMEZONE HANDLING
# --------------------------------------------------

_timezone_warning_shown = False


def get_local_now() -> datetime:
    """Return the current time in the configured timezone."""

    global _timezone_warning_shown

    timezone_name = os.getenv("APP_TIMEZONE", DEFAULT_TIMEZONE)

    try:
        if ZoneInfo is None:
            raise RuntimeError("zoneinfo is not available")

        return datetime.now(ZoneInfo(timezone_name))

    except Exception:
        if not _timezone_warning_shown:
            logger.warning(
                "Timezone '%s' could not be loaded. "
                "Install the tzdata package. "
                "Falling back to this computer's local time.",
                timezone_name,
            )
            _timezone_warning_shown = True

        return datetime.now().astimezone()


def get_today() -> date:
    """Return today's date in the configured timezone."""

    return get_local_now().date()


def validate_date(appointment_date: str) -> bool:
    """Validate YYYY-MM-DD dates and reject dates in the past."""

    try:
        parsed_date = date.fromisoformat(appointment_date)
        return parsed_date >= get_today()

    except (ValueError, TypeError):
        return False


# --------------------------------------------------
# APPOINTMENT JSON STORAGE
# --------------------------------------------------

def load_appointments() -> list:
    """Load appointment records from JSON."""

    if not DATA_FILE.exists():
        save_appointments([])

    with open(DATA_FILE, "r", encoding="utf-8") as file:
        data = json.load(file)

    return data.get("appointments", [])


def save_appointments(appointments: list) -> None:
    """Save appointment records to JSON."""

    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)

    with open(DATA_FILE, "w", encoding="utf-8") as file:
        json.dump(
            {"appointments": appointments},
            file,
            indent=4,
        )


# --------------------------------------------------
# CHECK DOCTOR AVAILABILITY
# --------------------------------------------------

def check_doctor_availability(
    speciality: str,
    appointment_date: str,
) -> dict:
    """Find doctors and available appointment slots."""

    if not isinstance(speciality, str) or not speciality.strip():
        return {
            "success": False,
            "message": "Please provide a medical speciality.",
            "doctors": [],
        }

    if not validate_date(appointment_date):
        return {
            "success": False,
            "message": (
                "Invalid date. Use YYYY-MM-DD "
                "and choose today or a future date."
            ),
            "doctors": [],
        }

    normalized_speciality = normalize_speciality(speciality)

    appointments = load_appointments()
    results = []

    for doctor in DOCTORS:
        doctor_speciality = normalize_speciality(
            doctor["speciality"]
        )

        if doctor_speciality != normalized_speciality:
            continue

        booked_slots = [
            appointment["time"]
            for appointment in appointments
            if appointment["doctor_id"] == doctor["doctor_id"]
            and appointment["date"] == appointment_date
            and appointment["status"] == "booked"
        ]

        available_slots = [
            slot
            for slot in doctor["slots"]
            if slot not in booked_slots
        ]

        results.append({
            "doctor_id": doctor["doctor_id"],
            "doctor_name": doctor["doctor_name"],
            "speciality": doctor["speciality"],
            "date": appointment_date,
            "available_slots": available_slots,
        })

    if not results:
        return {
            "success": True,
            "message": "No doctors found for this speciality.",
            "doctors": [],
        }

    return {
        "success": True,
        "message": "Doctor availability retrieved.",
        "doctors": results,
    }


# --------------------------------------------------
# BOOK APPOINTMENT
# --------------------------------------------------

def book_appointment(
    phone_number: str,
    doctor_id: str,
    appointment_date: str,
    time: str,
) -> dict:
    """Book an available appointment for a confirmed caller number."""

    if not validate_phone_number(phone_number):
        return {
            "success": False,
            "message": "Please provide a valid phone number.",
        }

    phone_number = normalize_phone_number(phone_number)

    if not validate_date(appointment_date):
        return {
            "success": False,
            "message": "Invalid appointment date.",
        }

    doctor = next(
        (
            item for item in DOCTORS
            if item["doctor_id"] == doctor_id
        ),
        None,
    )

    if doctor is None:
        return {
            "success": False,
            "message": "Doctor not found.",
        }

    if time not in doctor["slots"]:
        return {
            "success": False,
            "message": "Invalid appointment time.",
        }

    appointments = load_appointments()

    for appointment in appointments:
        if (
            appointment["doctor_id"] == doctor_id
            and appointment["date"] == appointment_date
            and appointment["time"] == time
            and appointment["status"] == "booked"
        ):
            return {
                "success": False,
                "message": "This appointment slot is already booked.",
            }

    appointment = {
        "appointment_id": str(uuid4()),
        "phone_number": phone_number,
        "doctor_id": doctor["doctor_id"],
        "doctor_name": doctor["doctor_name"],
        "speciality": doctor["speciality"],
        "date": appointment_date,
        "time": time,
        "status": "booked",
    }

    appointments.append(appointment)
    save_appointments(appointments)

    return {
        "success": True,
        "message": "Appointment booked successfully.",
        "appointment": appointment,
    }


# --------------------------------------------------
# CANCEL APPOINTMENT
# --------------------------------------------------

def cancel_appointment(
    phone_number: str,
    appointment_id: str = None,
) -> dict:
    """Cancel an active appointment belonging to the caller."""

    if not validate_phone_number(phone_number):
        return {
            "success": False,
            "message": "Please provide a valid phone number.",
        }

    phone_number = normalize_phone_number(phone_number)
    appointments = load_appointments()

    matching_appointments = [
        appointment
        for appointment in appointments
        if appointment["phone_number"] == phone_number
        and appointment["status"] == "booked"
    ]

    if not matching_appointments:
        return {
            "success": False,
            "message": "No active appointments found for this phone number.",
        }

    if appointment_id is None:
        if len(matching_appointments) > 1:
            return {
                "success": True,
                "requires_selection": True,
                "message": (
                    "Multiple appointments found. "
                    "Ask the caller which one to cancel."
                ),
                "appointments": matching_appointments,
            }

        target = matching_appointments[0]

    else:
        target = next(
            (
                appointment
                for appointment in matching_appointments
                if appointment["appointment_id"] == appointment_id
            ),
            None,
        )

        if target is None:
            return {
                "success": False,
                "message": "No matching active appointment found.",
            }

    target["status"] = "cancelled"
    save_appointments(appointments)

    return {
        "success": True,
        "message": "Appointment cancelled successfully.",
        "appointment": target,
    }
