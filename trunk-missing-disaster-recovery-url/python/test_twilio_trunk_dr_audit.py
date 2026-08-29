from twilio_trunk_dr_audit import enabled_uris, scheme_of, verdict


def test_empty_disaster_recovery_url_is_exposed():
    state, detail = verdict({"disaster_recovery_url": ""})
    assert state == "exposed"
    assert "no fallback" in detail


def test_missing_field_reads_the_same_as_an_empty_one():
    assert verdict({})[0] == "exposed"
    assert verdict({"disaster_recovery_url": None})[0] == "exposed"


def test_method_without_a_url_is_still_exposed():
    # A method is not a destination. Reading the pair as configured because one
    # half is populated is the mistake this case exists to prevent.
    assert verdict({"disaster_recovery_method": "POST"})[0] == "exposed"


def test_cleartext_disaster_recovery_url_is_its_own_state():
    state, _ = verdict({"disaster_recovery_url": "http://dr.example.com/twiml"})
    assert state == "dr-cleartext"


def test_https_url_with_no_origination_check_is_covered():
    # origination=None means not checked, and must not be read as "no URIs".
    state, detail = verdict({"disaster_recovery_url": "https://dr.example.com/twiml"})
    assert state == "covered"
    assert "the default" in detail


def test_checked_and_empty_origination_is_not_the_same_as_unchecked():
    state, _ = verdict({"disaster_recovery_url": "https://dr.example.com/twiml"}, [])
    assert state == "no-origination"


def test_disabled_uris_do_not_count_towards_redundancy():
    origination = [
        {"sip_url": "sip:a.example.com", "enabled": True},
        {"sip_url": "sip:b.example.com", "enabled": False},
        {"sip_url": "sip:c.example.com", "enabled": False},
    ]
    state, detail = verdict(
        {"disaster_recovery_url": "https://dr.example.com/twiml"}, origination)
    assert state == "single-uri"
    assert "a.example.com" in detail
    assert len(enabled_uris(origination)) == 1


def test_two_live_uris_and_a_recovery_url_is_covered():
    origination = [{"sip_url": "sip:a", "enabled": True},
                   {"sip_url": "sip:b", "enabled": True}]
    assert verdict({"disaster_recovery_url": "https://dr.example.com/twiml",
                    "disaster_recovery_method": "post"}, origination)[0] == "covered"


def test_scheme_of_handles_a_bare_host():
    assert scheme_of("HTTPS://dr.example.com/x") == "https"
    assert scheme_of("dr.example.com/x") == ""
