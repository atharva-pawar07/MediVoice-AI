
from services.appointment_service import (
    check_doctor_availability,
    book_appointment,
    cancel_appointment,
)

TEST_PHONE = "919876543210"
TEST_DATE = "2026-11-26"
DOCTOR_ID = "DOC003"
TEST_TIME = "04:00 PM"


# Test 1: Check doctor availability
availability = check_doctor_availability(
    "General Physician",
    TEST_DATE,
)

assert availability["success"] is True
assert any(
    doctor["doctor_id"] == DOCTOR_ID
    and TEST_TIME in doctor["available_slots"]
    for doctor in availability["doctors"]
), "Test slot is not available."

print("PASS: Doctor availability")


# Test 2: Book an appointment
booking = book_appointment(
    TEST_PHONE,
    DOCTOR_ID,
    TEST_DATE,
    TEST_TIME,
)

assert booking["success"] is True, booking

print("PASS: Appointment booking")


# Test 3: Prevent duplicate booking
duplicate = book_appointment(
    TEST_PHONE,
    DOCTOR_ID,
    TEST_DATE,
    TEST_TIME,
)

assert duplicate["success"] is False

print("PASS: Duplicate booking prevention")


# Test 4: Cancel the appointment
cancellation = cancel_appointment(TEST_PHONE)

assert cancellation["success"] is True, cancellation
assert cancellation["appointment"]["status"] == "cancelled"

print("PASS: Appointment cancellation")


# Test 5: Verify the slot is available again
availability_after_cancel = check_doctor_availability(
    "General Physician",
    TEST_DATE,
)

assert any(
    doctor["doctor_id"] == DOCTOR_ID
    and TEST_TIME in doctor["available_slots"]
    for doctor in availability_after_cancel["doctors"]
), "Cancelled slot was not released."

print("PASS: Slot availability after cancellation")

print("\nAll 5 appointment service tests passed!")
