
import asyncio
import tempfile
from pathlib import Path
from types import SimpleNamespace
from datetime import date, timedelta

from services import appointment_service
from services.appointment_tools import create_appointment_tools


async def main():
    with tempfile.TemporaryDirectory() as temp_dir:
        original_file = appointment_service.DATA_FILE
        appointment_service.DATA_FILE = (
            Path(temp_dir) / "appointments.json"
        )

        try:
            tools = create_appointment_tools()
            results = {}
            messages = []

            context = SimpleNamespace(
                get_messages=lambda: messages
            )

            async def call_tool(name, arguments):
                tool = next(
                    item for item in tools
                    if item.name == name
                )

                async def result_callback(result):
                    results[name] = result

                params = SimpleNamespace(
                    arguments=arguments,
                    result_callback=result_callback,
                    context=context,
                )

                await tool.handler(params)
                return results[name]

            def set_conversation(assistant_text, user_text):
                messages.clear()
                messages.extend([
                    {
                        "role": "assistant",
                        "content": assistant_text,
                    },
                    {
                        "role": "user",
                        "content": user_text,
                    },
                ])

            phone = "919876543210"
            appointment_date = (
                date.today() + timedelta(days=1)
            ).isoformat()

            date_for_speech = date.fromisoformat(
                appointment_date
            ).strftime("%B %d, %Y")

            # Test 1: Check doctor availability
            result = await call_tool(
                "check_doctor_availability",
                {
                    "speciality": "General Physician",
                    "appointment_date": appointment_date,
                },
            )

            assert result["success"] is True
            assert len(result["doctors"]) > 0
            print("PASS: Doctor availability")

            # Test 2: Phone number cannot be confirmed immediately
            result = await call_tool(
                "confirm_phone_number",
                {"phone_number": phone},
            )

            assert result["success"] is True
            assert result["confirmed"] is False
            assert result["requires_confirmation"] is True
            print("PASS: Phone confirmation requires read-back")

            # Test 3: Phone number confirmation after read-back
            set_conversation(
                f"Your phone number is {phone}. Is that correct?",
                "yes",
            )

            result = await call_tool(
                "confirm_phone_number",
                {"phone_number": phone},
            )

            assert result["confirmed"] is True
            print("PASS: Phone number confirmed after approval")

            # Test 4: Booking cannot happen without appointment approval
            booking_arguments = {
                "doctor_id": "DOC003",
                "appointment_date": appointment_date,
                "time": "04:00 PM",
            }

            result = await call_tool(
                "book_appointment",
                booking_arguments,
            )

            assert result["success"] is True
            assert result["booked"] is False
            assert result["requires_confirmation"] is True
            print("PASS: Booking requires appointment read-back")

            # Test 5: Saying no must prevent booking
            set_conversation(
                (
                    f"Dr. Priya Nair, {date_for_speech}, "
                    "at 04:00 PM. Should I book it?"
                ),
                "no",
            )

            result = await call_tool(
                "book_appointment",
                booking_arguments,
            )

            assert result["success"] is False
            assert result["booked"] is False
            assert len(appointment_service.load_appointments()) == 0
            print("PASS: Booking blocked after caller says no")

            # Test 6: Booking after explicit approval
            result = await call_tool(
                "book_appointment",
                booking_arguments,
            )

            assert result["booked"] is False

            set_conversation(
                (
                    f"Dr. Priya Nair, {date_for_speech}, "
                    "at 04:00 PM. Should I book it?"
                ),
                "yes",
            )

            result = await call_tool(
                "book_appointment",
                booking_arguments,
            )

            assert result["success"] is True
            assert result["appointment"]["status"] == "booked"

            appointment_id = result["appointment"]["appointment_id"]
            print("PASS: Booking after explicit approval")

            # Test 7: Find active appointments
            result = await call_tool(
                "cancel_appointment",
                {},
            )

            assert result["success"] is True
            assert len(result["appointments"]) == 1
            print("PASS: Find caller's active appointments")

            # Test 8: Cancellation requires confirmation
            cancellation_arguments = {
                "appointment_id": appointment_id,
            }

            result = await call_tool(
                "cancel_appointment",
                cancellation_arguments,
            )

            assert result["success"] is True
            assert result["cancelled"] is False
            assert result["requires_confirmation"] is True
            print("PASS: Cancellation requires read-back")

            # Test 9: Saying no must prevent cancellation
            set_conversation(
                (
                    f"Cancel your appointment with Dr. Priya Nair "
                    f"on {date_for_speech} at 04:00 PM. "
                    "Should I cancel it?"
                ),
                "no",
            )

            result = await call_tool(
                "cancel_appointment",
                cancellation_arguments,
            )

            assert result["success"] is False
            assert result["cancelled"] is False

            appointment = appointment_service.load_appointments()[0]
            assert appointment["status"] == "booked"
            print("PASS: Cancellation blocked after caller says no")

            # Test 10: Cancellation after explicit approval
            result = await call_tool(
                "cancel_appointment",
                cancellation_arguments,
            )

            assert result["cancelled"] is False

            set_conversation(
                (
                    f"Cancel your appointment with Dr. Priya Nair "
                    f"on {date_for_speech} at 04:00 PM. "
                    "Should I cancel it?"
                ),
                "yes",
            )

            result = await call_tool(
                "cancel_appointment",
                cancellation_arguments,
            )

            assert result["success"] is True
            assert result["appointment"]["status"] == "cancelled"

            appointment = appointment_service.load_appointments()[0]
            assert appointment["status"] == "cancelled"
            print("PASS: Cancellation after explicit approval")

            print("\nAll 10 appointment tool tests passed!")

        finally:
            appointment_service.DATA_FILE = original_file


if __name__ == "__main__":
    asyncio.run(main())
