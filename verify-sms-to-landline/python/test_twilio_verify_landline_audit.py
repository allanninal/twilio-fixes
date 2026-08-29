from twilio_verify_landline_audit import guard_state, line_type, verdict


def test_landline_on_the_sms_channel_is_the_finding():
    state, detail = verdict({"line_type_intelligence": {"type": "landline"}})
    assert state == "no-sms"
    assert "60205" in detail


def test_the_same_landline_on_a_voice_verification_is_fine():
    state, _ = verdict({"line_type_intelligence": {"type": "landline"}},
                       channel="call")
    assert state == "voice-ok"


def test_fixed_voip_is_neither_a_pass_nor_a_rejection():
    # Camel case from the API, matched case-insensitively.
    state, detail = verdict({"line_type_intelligence": {"type": "fixedVoip"}})
    assert state == "unreliable"
    assert "voice call" in detail


def test_a_response_with_no_line_type_is_not_a_mobile():
    state, detail = verdict({"valid": True})
    assert state == "no-line-type"
    assert "Fields=line_type_intelligence" in detail


def test_mobile_passes():
    assert verdict({"line_type_intelligence": {"type": "mobile"}})[0] == "mobile"
    assert line_type({"line_type_intelligence": {"type": "  Mobile "}}) == "mobile"


def test_skip_without_lookup_is_a_setting_that_does_nothing():
    state, detail = guard_state({"lookup_enabled": False,
                                 "skip_sms_to_landlines": True})
    assert state == "no-op"
    assert "does nothing" in detail


def test_both_settings_on_is_the_only_guarded_state():
    assert guard_state({"lookup_enabled": True,
                        "skip_sms_to_landlines": True})[0] == "guarded"
    assert guard_state({"lookup_enabled": True,
                        "skip_sms_to_landlines": False})[0] == "lookup-only"
    assert guard_state({})[0] == "unguarded"
