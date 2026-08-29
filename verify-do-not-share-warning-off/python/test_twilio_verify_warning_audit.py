from twilio_verify_warning_audit import verdict

TEMPLATES = {"HJ0123456789": {"sid": "HJ0123456789", "friendly_name": "signup v3"}}


def test_the_flag_off_is_the_headline_finding():
    state, detail = verdict({"do_not_share_warning_enabled": False,
                             "dtmf_input_required": True}, {})
    assert state == "no-warning"
    assert "nothing else" in detail


def test_a_custom_template_is_not_a_pass_even_with_the_flag_on():
    state, detail = verdict({"do_not_share_warning_enabled": True,
                             "dtmf_input_required": True,
                             "default_template_sid": "HJ0123456789"}, TEMPLATES)
    assert state == "custom-template"
    assert "signup v3" in detail


def test_a_template_the_key_cannot_read_is_unknown_not_broken():
    state, detail = verdict({"do_not_share_warning_enabled": True,
                             "dtmf_input_required": True,
                             "default_template_sid": "HJ9999999999"}, TEMPLATES)
    assert state == "unresolved-template"
    assert "Unknown, not covered" in detail


def test_the_default_template_with_the_flag_on_passes():
    state, _ = verdict({"do_not_share_warning_enabled": True,
                        "dtmf_input_required": True}, TEMPLATES)
    assert state == "warned"


def test_dtmf_is_only_a_finding_when_voice_is_actually_used():
    exposed, detail = verdict({"do_not_share_warning_enabled": True,
                               "dtmf_input_required": False}, {}, voice_in_use=True)
    assert exposed == "voice-exposed"
    assert "voicemail box" in detail
    assert verdict({"do_not_share_warning_enabled": True,
                    "dtmf_input_required": False}, {}, voice_in_use=False)[0] == "warned"


def test_an_unchecked_voice_channel_is_a_note_not_a_verdict():
    state, detail = verdict({"do_not_share_warning_enabled": True,
                             "dtmf_input_required": False}, {})
    assert state == "warned"
    assert "if you ever send" in detail


def test_a_missing_flag_reads_as_off():
    assert verdict({}, {})[0] == "no-warning"
