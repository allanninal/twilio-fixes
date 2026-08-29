from twilio_fallback_audit import verdict

APP = "AP0123456789"


def test_live_voice_handler_with_no_fallback_is_exposed():
    state, detail = verdict({"voice_url": "https://app.example.com/voice"})
    assert state == "exposed"
    assert "dropped" in detail


def test_fallback_on_the_number_is_covered():
    state, _ = verdict({"voice_url": "https://app.example.com/voice",
                        "voice_fallback_url": "https://handler.twilio.com/twiml/EH1"})
    assert state == "covered"


def test_application_sid_wins_so_a_fallback_on_the_number_does_not_count():
    # The mistake this note exists to prevent: the number looks protected and is not.
    state, detail = verdict(
        {"voice_application_sid": APP,
         "voice_url": "https://app.example.com/voice",
         "voice_fallback_url": "https://handler.twilio.com/twiml/EH1"},
        {APP: {"voice_url": "https://app.example.com/voice"}})
    assert state == "exposed"
    assert APP in detail


def test_fallback_on_the_application_counts():
    state, _ = verdict(
        {"voice_application_sid": APP},
        {APP: {"voice_url": "https://app.example.com/voice",
               "voice_fallback_url": "https://handler.twilio.com/twiml/EH1"}})
    assert state == "covered"


def test_sms_is_checked_when_voice_is_fine():
    state, detail = verdict({"voice_url": "https://app.example.com/voice",
                             "voice_fallback_url": "https://handler.twilio.com/twiml/EH1",
                             "sms_url": "https://app.example.com/sms"})
    assert state == "exposed"
    assert "sms" in detail


def test_number_with_no_handler_is_idle_not_exposed():
    state, _ = verdict({"voice_url": "", "sms_url": None})
    assert state == "idle"


def test_unread_application_is_not_guessed_at():
    state, _ = verdict({"voice_application_sid": APP}, {})
    assert state == "unresolved"
