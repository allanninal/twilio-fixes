from twilio_number_app_precedence_audit import sharing, verdict

APP = "AP11111111111111111111111111111111"
OTHER = "AP22222222222222222222222222222222"


def test_a_different_url_on_the_number_is_shadowed():
    # The whole note: this number looks configured and the field is inert.
    state, detail = verdict(
        {"voice_application_sid": APP, "voice_url": "https://new.example.com/voice"},
        {APP: {"voice_url": "https://retired.example.com/voice"}})
    assert state == "shadowed"
    assert "retired.example.com" in detail
    assert "Editing the number changes nothing" in detail


def test_the_same_url_on_both_is_not_a_finding():
    state, _ = verdict(
        {"voice_application_sid": APP, "voice_url": "https://app.example.com/voice"},
        {APP: {"voice_url": "https://app.example.com/voice"}})
    assert state == "app-routed"


def test_an_application_with_no_url_routes_nowhere():
    state, detail = verdict(
        {"voice_application_sid": APP, "voice_url": "https://app.example.com/voice"},
        {APP: {"voice_url": ""}})
    assert state == "routes-nowhere"
    assert "has no voice_url" in detail


def test_sms_precedence_is_checked_independently():
    state, detail = verdict(
        {"voice_url": "https://app.example.com/voice",
         "sms_application_sid": APP, "sms_url": "https://new.example.com/sms"},
        {APP: {"sms_url": "https://retired.example.com/sms"}})
    assert state == "shadowed"
    assert "sms:" in detail


def test_no_application_sid_means_the_number_is_read():
    state, detail = verdict({"voice_url": "https://app.example.com/voice"})
    assert state == "direct"
    assert "app.example.com" in detail


def test_an_unread_application_is_never_guessed_at():
    state, _ = verdict({"voice_application_sid": APP}, {})
    assert state == "unresolved"


def test_a_number_with_nothing_configured_is_idle():
    assert verdict({"voice_url": "", "sms_url": None})[0] == "idle"


def test_sharing_lists_every_number_on_one_app_once():
    numbers = [
        {"phone_number": "+15550001111", "voice_application_sid": APP,
         "sms_application_sid": APP},
        {"phone_number": "+15550002222", "sms_application_sid": APP},
        {"phone_number": "+15550003333", "voice_application_sid": OTHER},
    ]
    assert sharing(numbers, APP) == ["+15550001111", "+15550002222"]
    assert sharing(numbers, OTHER) == ["+15550003333"]
