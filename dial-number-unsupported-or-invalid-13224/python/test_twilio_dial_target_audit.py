from twilio_dial_target_audit import e164_digits, refused_range, verdict


def test_national_format_is_the_common_cause():
    state, detail = verdict({"to": "01614960000", "direction": "outbound-api"})
    assert state == "not-e164"
    assert "predates E.164" in detail


def test_punctuated_number_is_malformed_rather_than_tidied():
    # Cleaning it here would hide the thing the application should have done.
    state, _ = verdict({"to": "+44 161 496 0000", "direction": "outbound-api"})
    assert state == "malformed"


def test_inbound_call_does_not_carry_the_dial_target():
    state, detail = verdict({"to": "+441614960000", "direction": "inbound"})
    assert state == "target-not-on-record"
    assert "AlertSid" in detail


def test_premium_range_is_unsupported_not_invalid():
    state, detail = verdict({"to": "+19005551234", "direction": "outbound-api"})
    assert state == "refused-range"
    assert "North American premium rate" in detail


def test_longest_prefix_wins_over_the_shorter_one():
    assert refused_range("+447012345678") == \
        "UK personal numbering, forwarded at premium cost"
    assert refused_range("+449001234567") == "UK premium rate"


def test_extension_dialled_as_a_number_is_too_short():
    state, _ = verdict({"to": "+4021", "direction": "outbound-dial"})
    assert state == "too-short"


def test_well_formed_unknown_number_points_at_lookups():
    state, detail = verdict({"to": "+15005550001", "direction": "outbound-api"})
    assert state == "unallocated"
    assert "valid false" in detail


def test_e164_digits_is_strict_about_the_ceiling_and_the_plus():
    assert e164_digits("+441614960000") == "441614960000"
    assert e164_digits("441614960000") == ""
    assert e164_digits("+1234567890123456") == ""
