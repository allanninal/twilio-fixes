from twilio_dial_caller_id_audit import caller_id_state, verdict

OWNED = {"+15005550006"}


def test_plain_e164_is_accepted():
    assert caller_id_state("+15005550006") == "e164"


def test_national_format_has_no_country_code():
    assert caller_id_state("5005550006") == "not-e164"


def test_spaces_and_punctuation_are_not_e164():
    assert caller_id_state("+1 500 555-0006") == "not-e164"


def test_withheld_markers_are_their_own_state():
    assert caller_id_state("anonymous") == "withheld"
    assert caller_id_state("Restricted") == "withheld"


def test_sip_uri_and_client_identity_are_distinguished():
    assert caller_id_state("sip:alice@example.com") == "sip-uri"
    assert caller_id_state("client:alice") == "client"


def test_sixteen_digits_is_outside_e164():
    assert caller_id_state("+1234567890123456") == "out-of-range"


def test_empty_is_absent():
    assert caller_id_state("") == "absent"
    assert caller_id_state(None) == "absent"


def test_bad_from_on_an_inbound_call_is_passthrough():
    state, detail = verdict({"from": "5005550006", "direction": "inbound"}, OWNED)
    assert state == "passthrough"
    assert "no callerId" in detail


def test_bad_from_on_an_outbound_call_is_not_passthrough():
    state, _ = verdict({"from": "anonymous", "direction": "outbound-api"}, OWNED)
    assert state == "malformed"


def test_well_formed_but_unowned_number_is_still_a_13214():
    # The case that reads as a false positive and is not: valid E.164 is not
    # the same as a caller ID this account is allowed to present.
    state, detail = verdict({"from": "+15005550999", "direction": "inbound"}, OWNED)
    assert state == "unverified"
    assert "verified outgoing caller ID" in detail


def test_owned_number_points_the_investigation_elsewhere():
    state, _ = verdict({"from": "+15005550006", "direction": "inbound"}, OWNED)
    assert state == "presentable"
